import type { Actor, Db } from "./actor";
import { assertCanRead } from "./access";
import { NotFoundError } from "./errors";
import {
  exportMarkdownInput,
  mcpReadInput,
  type ExportMarkdownInput,
  type ExportMarkdownMode,
  type McpReadInput,
} from "~/lib/schemas";
import {
  serializeGraph,
  type SerializerBoundaryProxy,
  type SerializerEdge,
  type SerializerNode,
} from "./markdown";
import { type NodeKind as PrismaNodeKind } from "../../../generated/prisma/client";

/**
 * Deterministic markdown export of a Project or subtree (M2 / #15; ADR-0017).
 *
 * Two authorized front doors share one fetch-and-serialize core
 * ({@link serializeProjectScope}):
 *
 *  - {@link exportMarkdown} — slug-readable (ADR-0002): possession of the
 *    capability slug is the read grant. The web "Copy as markdown" path.
 *  - {@link exportMarkdownForActor} — owner-gated (#18): a bearer-token Actor
 *    reads only its own projects, addressed by internal id. The MCP read path.
 *
 * Read shape — depth-independent, no waterfall (ADR-0001 single-round-trip):
 *
 *  - Whole project (`canvasNodeId === null`): two flat reads in parallel.
 *    Boundary is empty (the root has no ancestors).
 *  - Subtree (`canvasNodeId === R`): three reads in parallel. Two share the
 *    same descent CTE shape (one returns the subtree nodes, one returns the
 *    INTERNAL Connections — both endpoints inside the subtree) — running them
 *    in parallel keeps the round trip flat at the cost of one extra recursive
 *    walk on the server, far cheaper than a second client → server round trip.
 *    The third derives the **boundary context** by endpoint membership: the far
 *    endpoint of any Connection crossing the subtree boundary. An Edge no longer
 *    stores a scope (ADR-0028), so all three derive from endpoint ancestry; the
 *    full typed cross-scope export rewrite is #67.
 *
 * Serialization is delegated to the pure `serializeGraph` (no `db`, no authz) —
 * the unit both front doors reuse without re-implementing the format.
 *
 * Raw-SQL discipline (ADR-0006): every identifier is double-quoted
 * PascalCase; the scope id and project id are bound parameters; user-
 * authored content is never interpolated.
 */

// Defensive bound on the descent / ancestry walks. Reparenting exists
// (`moveNode`), which rejects cycles at the write — so a cycle cannot occur
// for clean data; this cap is the belt-and-suspenders backstop if that guard
// ever regresses or bad data slips in. Shared with `node.service.ts`'s
// `ANCESTRY_DEPTH_CAP`; it is a recursion fuse, not a real nesting limit.
const SUBTREE_DEPTH_CAP = 256;

interface SubtreeNodeRow {
  id: string;
  parentId: string | null;
  title: string;
  kind: PrismaNodeKind;
  documentation: string;
}

interface SubtreeEdgeRow {
  id: string;
  sourceId: string;
  targetId: string;
  label: string | null;
}

interface BoundaryRow {
  node_id: string;
  title: string;
  kind: PrismaNodeKind;
  is_direct: boolean;
}

interface ResolvedProject {
  projectId: string;
  projectTitle: string;
}

/**
 * The shared fetch-and-serialize core, keyed by an ALREADY-RESOLVED,
 * already-authorized project. Holds the depth-independent reads (whole-project:
 * two flat reads; subtree: three concurrent CTEs) and delegates to the pure
 * `serializeGraph`. It carries NO authorization and NO slug: the two front doors
 * above it — `exportMarkdown` (slug grant, ADR-0002) and `exportMarkdownForActor`
 * (owner gate, #18) — each resolve a project under their own posture and then
 * share this body. Keeping the two grant models in physically separate callers
 * means neither can weaken the other (they share fetch, not authz; ADR-0017's
 * pure/fetch split refined into three layers).
 */
async function serializeProjectScope(
  db: Db,
  project: ResolvedProject,
  opts: { canvasNodeId: string | null; mode: ExportMarkdownMode },
): Promise<{ markdown: string }> {
  const { projectId, projectTitle } = project;
  const { canvasNodeId, mode } = opts;

  let nodes: SerializerNode[];
  let edges: SerializerEdge[];
  let boundaryProxies: SerializerBoundaryProxy[];

  if (canvasNodeId === null) {
    const [nodeRows, edgeRows] = await Promise.all([
      db.node.findMany({
        where: { projectId: projectId, deletedAt: null },
        select: {
          id: true,
          parentId: true,
          title: true,
          kind: true,
          documentation: true,
        },
      }),
      db.edge.findMany({
        where: { projectId: projectId, deletedAt: null },
        select: {
          id: true,
          sourceId: true,
          targetId: true,
          label: true,
        },
      }),
    ]);
    nodes = nodeRows;
    edges = edgeRows.map((e) => ({
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
      label: e.label,
    }));
    boundaryProxies = [];
  } else {
    const [subtreeRows, subtreeEdgeRows, boundaryRows] = await Promise.all([
      db.$queryRaw<SubtreeNodeRow[]>`
        WITH RECURSIVE subtree AS (
          SELECT n.id, n."parentId", n.title, n.kind, n.documentation, 0 AS depth
          FROM "Node" n
          WHERE n.id = ${canvasNodeId}
            AND n."projectId" = ${projectId}
            AND n."deletedAt" IS NULL
          UNION ALL
          SELECT c.id, c."parentId", c.title, c.kind, c.documentation, s.depth + 1
          FROM "Node" c
          JOIN subtree s ON c."parentId" = s.id
          WHERE c."projectId" = ${projectId}
            AND c."deletedAt" IS NULL
            AND s.depth < ${SUBTREE_DEPTH_CAP}
        )
        SELECT id, "parentId", title, kind, documentation FROM subtree`,
      // Internal Connections: both endpoints inside the subtree. An Edge no
      // longer stores a scope (ADR-0028), so membership of both endpoints is
      // the whole predicate; boundary-crossing Connections surface in the
      // Boundary section below instead.
      db.$queryRaw<SubtreeEdgeRow[]>`
        WITH RECURSIVE subtree AS (
          SELECT n.id, 0 AS depth
          FROM "Node" n
          WHERE n.id = ${canvasNodeId}
            AND n."projectId" = ${projectId}
            AND n."deletedAt" IS NULL
          UNION ALL
          SELECT c.id, s.depth + 1
          FROM "Node" c
          JOIN subtree s ON c."parentId" = s.id
          WHERE c."projectId" = ${projectId}
            AND c."deletedAt" IS NULL
            AND s.depth < ${SUBTREE_DEPTH_CAP}
        )
        SELECT e.id, e."sourceId", e."targetId", e.label
        FROM "Edge" e
        WHERE e."projectId" = ${projectId}
          AND e."deletedAt" IS NULL
          AND e."sourceId" IN (SELECT id FROM subtree)
          AND e."targetId" IN (SELECT id FROM subtree)`,
      // Boundary context: the far endpoint of any active Connection that
      // crosses the subtree boundary (exactly one endpoint inside). Derived
      // from endpoint membership, not the old transitive ancestor walk (#67
      // owns the full cross-scope rewrite). `is_direct` marks a Connection
      // incident to the subtree root R itself, vs a deeper descendant.
      db.$queryRaw<BoundaryRow[]>`
        WITH RECURSIVE subtree AS (
          SELECT n.id, 0 AS depth
          FROM "Node" n
          WHERE n.id = ${canvasNodeId}
            AND n."projectId" = ${projectId}
            AND n."deletedAt" IS NULL
          UNION ALL
          SELECT c.id, s.depth + 1
          FROM "Node" c
          JOIN subtree s ON c."parentId" = s.id
          WHERE c."projectId" = ${projectId}
            AND c."deletedAt" IS NULL
            AND s.depth < ${SUBTREE_DEPTH_CAP}
        )
        SELECT
          proxy.id AS node_id,
          proxy.title AS title,
          proxy.kind AS kind,
          BOOL_OR(inside.id = ${canvasNodeId}) AS is_direct
        FROM "Edge" e
        JOIN subtree inside
          ON inside.id = e."sourceId" OR inside.id = e."targetId"
        JOIN "Node" proxy
          ON proxy.id = CASE
            WHEN e."sourceId" = inside.id THEN e."targetId"
            ELSE e."sourceId"
          END
          AND proxy."deletedAt" IS NULL
        WHERE e."projectId" = ${projectId}
          AND e."deletedAt" IS NULL
          AND proxy.id NOT IN (SELECT id FROM subtree)
        GROUP BY proxy.id, proxy.title, proxy.kind`,
    ]);

    // Subtree existence check: the CTE always returns at least the anchor
    // row when the scope resolves to a live Node in this Project (same
    // posture `getCanvas`'s breadcrumb trail uses — ADR-0006). An empty
    // result means the `canvasNodeId` is missing, soft-deleted, or
    // cross-project.
    if (subtreeRows.length === 0) {
      throw new NotFoundError();
    }

    nodes = subtreeRows.map((r) => ({
      id: r.id,
      parentId: r.parentId,
      title: r.title,
      kind: r.kind,
      documentation: r.documentation,
    }));
    edges = subtreeEdgeRows.map((e) => ({
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
      label: e.label,
    }));
    boundaryProxies = boundaryRows.map((r) => ({
      nodeId: r.node_id,
      title: r.title,
      kind: r.kind,
      origin: r.is_direct ? "direct" : "inherited",
    }));
  }

  const markdown = serializeGraph({
    project: { title: projectTitle },
    rootCanvasNodeId: canvasNodeId,
    nodes,
    edges,
    boundaryProxies,
    mode,
  });

  return { markdown };
}

/**
 * Renders a Project — or one of its subtrees — to deterministic markdown, the
 * web "Copy as markdown" / capability-URL path (M2 / #15; ADR-0017).
 *
 * Authz: slug-readable (ADR-0002), the same posture `getCanvas` uses —
 * possession of the unguessable slug IS the read grant, so no `access` check
 * runs here and `actor` is unused. (The owner-gated MCP read path is
 * {@link exportMarkdownForActor}.)
 */
export async function exportMarkdown(
  db: Db,
  _actor: Actor | null,
  input: ExportMarkdownInput,
): Promise<{ markdown: string }> {
  const { slug, canvasNodeId, mode } = exportMarkdownInput.parse(input);

  const project = await db.project.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, title: true },
  });
  if (!project) {
    throw new NotFoundError();
  }

  return serializeProjectScope(
    db,
    { projectId: project.id, projectTitle: project.title },
    { canvasNodeId, mode },
  );
}

/**
 * Renders a Project — or one of its subtrees — to deterministic markdown for the
 * owner-gated MCP read path (#18). Unlike {@link exportMarkdown}, the project is
 * addressed by internal `projectId` (never the slug) and the read is authorized
 * by ownership: the bearer-token Actor may read ONLY its own projects.
 *
 * Fetch-then-authorize over already-loaded data (ADR-0001): the `findFirst`
 * filters `deletedAt: null` so a soft-deleted project is not-found, and only a
 * live project's `ownerId` reaches `assertCanRead`. A project owned by another
 * user throws `ForbiddenError`; the MCP adapter collapses both not-found and
 * forbidden to one indistinguishable "not found" so existence never leaks
 * (ADR-0002). `assertCanRead` is called WITHOUT `viaCapabilitySlug`, so it is
 * owner-only — the slug grant can never be reached from this path.
 */
export async function exportMarkdownForActor(
  db: Db,
  actor: Actor,
  input: McpReadInput,
): Promise<{ markdown: string }> {
  const { projectId, canvasNodeId, mode } = mcpReadInput.parse(input);

  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: { id: true, title: true, ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanRead(actor, { ownerId: project.ownerId });

  return serializeProjectScope(
    db,
    { projectId: project.id, projectTitle: project.title },
    { canvasNodeId, mode },
  );
}
