import type { Actor, Db } from "./actor";
import { assertCanRead } from "./access";
import { authorizeProjectRead } from "./access-db";
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
  type SerializerBoundaryEdge,
  type SerializerEdge,
  type SerializerNode,
} from "./markdown";
import {
  type Interaction as PrismaInteraction,
  type NodeKind as PrismaNodeKind,
} from "../../../generated/prisma/client";

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
 *    The third derives the **boundary context** by endpoint membership: ONE
 *    row per Connection crossing the subtree boundary (per-edge, never
 *    coalesced by far Node; ADR-0031 posture extended to the export consumer
 *    at #67). An Edge no longer stores a scope (ADR-0028), so all three
 *    derive from endpoint ancestry; the `direct/inherited` partition is
 *    retired.
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
  interaction: PrismaInteraction;
  label: string | null;
}

/**
 * One boundary-crossing Connection — exactly one endpoint is inside the
 * exported subtree, the other is "far" (outside). Per-row, never coalesced
 * by far Node (ADR-0031 extended to the export consumer at #67): a single
 * external reached as the far end of N crossing Connections produces N rows.
 * The `direct/inherited` partition is retired.
 */
interface BoundaryEdgeRow {
  edge_id: string;
  source_id: string;
  target_id: string;
  interaction: PrismaInteraction;
  label: string | null;
  far_endpoint_id: string;
  far_title: string;
  far_kind: PrismaNodeKind;
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
  let boundaryEdges: SerializerBoundaryEdge[];

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
          interaction: true,
          label: true,
        },
      }),
    ]);
    nodes = nodeRows;
    edges = edgeRows.map((e) => ({
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
      interaction: e.interaction,
      label: e.label,
    }));
    boundaryEdges = [];
  } else {
    // The export's subtree derivation walks descendants under a root; it is
    // INTENTIONALLY separate from `getCanvas`'s whole-Project ancestry walk
    // (ADR-0031 §"Scope of this ADR" sanctions the two derivations — two
    // consumers, two purposes, no DRY). Re-introducing a DRY here would
    // regress that decision.
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
        SELECT e.id, e."sourceId", e."targetId", e.interaction, e.label
        FROM "Edge" e
        WHERE e."projectId" = ${projectId}
          AND e."deletedAt" IS NULL
          AND e."sourceId" IN (SELECT id FROM subtree)
          AND e."targetId" IN (SELECT id FROM subtree)`,
      // Boundary context: ONE row per active Connection that crosses the
      // subtree boundary (exactly one endpoint inside). Per-edge — never
      // coalesced by far Node (ADR-0031 amended onto the export consumer at
      // #67); the `direct/inherited` partition is retired. The far endpoint's
      // title and kind are denormalized so the pure serializer can render
      // the row without reaching for the DB.
      db.$queryRaw<BoundaryEdgeRow[]>`
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
          e.id AS edge_id,
          e."sourceId" AS source_id,
          e."targetId" AS target_id,
          e.interaction AS interaction,
          e.label AS label,
          far.id AS far_endpoint_id,
          far.title AS far_title,
          far.kind AS far_kind
        FROM "Edge" e
        JOIN "Node" src
          ON src.id = e."sourceId" AND src."deletedAt" IS NULL
        JOIN "Node" tgt
          ON tgt.id = e."targetId" AND tgt."deletedAt" IS NULL
        JOIN "Node" far
          ON far.id = CASE
            WHEN e."sourceId" IN (SELECT id FROM subtree) THEN e."targetId"
            ELSE e."sourceId"
          END
          AND far."deletedAt" IS NULL
        WHERE e."projectId" = ${projectId}
          AND e."deletedAt" IS NULL
          AND (
            (e."sourceId" IN (SELECT id FROM subtree)
              AND e."targetId" NOT IN (SELECT id FROM subtree))
            OR
            (e."targetId" IN (SELECT id FROM subtree)
              AND e."sourceId" NOT IN (SELECT id FROM subtree))
          )`,
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
      interaction: e.interaction,
      label: e.label,
    }));
    boundaryEdges = boundaryRows.map((r) => ({
      edgeId: r.edge_id,
      sourceId: r.source_id,
      targetId: r.target_id,
      interaction: r.interaction,
      label: r.label,
      farEndpointId: r.far_endpoint_id,
      farTitle: r.far_title,
      farKind: r.far_kind,
    }));
  }

  const markdown = serializeGraph({
    project: { title: projectTitle },
    rootCanvasNodeId: canvasNodeId,
    nodes,
    edges,
    boundaryEdges,
    mode,
  });

  return { markdown };
}

/**
 * Renders a Project — or one of its subtrees — to deterministic markdown, the
 * web "Copy as markdown" / capability-URL path (M2 / #15; ADR-0017).
 *
 * Authz: capability-gated on `view` via the slug→project bind (ADR-0040,
 * generalizing ADR-0002), the same posture `getCanvas` uses — the default
 * `guestAccess=VIEW` reproduces the old slug grant; a `guestAccess=NONE` project
 * is not-found for a non-member. (The owner-gated MCP read path is
 * {@link exportMarkdownForActor}.)
 */
export async function exportMarkdown(
  db: Db,
  actor: Actor | null,
  input: ExportMarkdownInput,
): Promise<{ markdown: string }> {
  const { slug, canvasNodeId, mode } = exportMarkdownInput.parse(input);

  const { project } = await authorizeProjectRead(db, actor, slug);

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
