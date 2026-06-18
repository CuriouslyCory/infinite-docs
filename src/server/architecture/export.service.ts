import type { Actor, Db } from "./actor";
import { capabilityAtLeast, resolveCapability } from "./access";
import { authorizeProjectRead, batchRegateReadable } from "./access-db";
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
  type SerializerCrossProjectMarker,
  type SerializerEdge,
  type SerializerNode,
  type SerializerPortalMarker,
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
  actor: Actor | null,
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

  // Non-recursive cross-project reference markers (#123 / ADR-0044): portals +
  // cross-project Connections among the exported nodes, per-actor re-gated and
  // resolved HERE (the pure serializer never resolves foreign content). An
  // anonymous export (`actor === null`) holds no foreign grant, so every foreign
  // project re-gate fails and zero markers are emitted (the firewall closes by
  // construction).
  const { portalMarkers, crossProjectMarkers } = await resolveCrossProjectMarkers(
    db,
    actor,
    projectId,
    nodes,
  );

  const markdown = serializeGraph({
    project: { title: projectTitle },
    rootCanvasNodeId: canvasNodeId,
    nodes,
    edges,
    boundaryEdges,
    mode,
    portalMarkers,
    crossProjectMarkers,
  });

  return { markdown };
}

/**
 * Resolves the NON-RECURSIVE cross-project reference markers for an exported
 * scope (#123 / ADR-0044) — the SAME per-actor firewall pass `getCanvas` runs
 * (ADR-0041), applied at the export boundary:
 *
 *  1. Read the PORTALS among the exported nodes (`embeddedProjectId != null`) and
 *     the live CrossProjectEdge rows whose host endpoint (`hostNodeId`) is in the
 *     exported set — both host-side reads, scoped to the host project.
 *  2. Per-actor re-gate EACH distinct foreign project (`resolveReadableProjectById`,
 *     DROP unreadable) and batch-read the surviving foreign project + foreign
 *     endpoint TITLES. A foreign project the actor cannot read contributes NO
 *     marker — its id/slug/title never reach the output.
 *
 * Returns already-resolved, already-filtered marker data; the pure serializer
 * renders titles only, never inlining foreign documentation.
 */
async function resolveCrossProjectMarkers(
  db: Db,
  actor: Actor | null,
  projectId: string,
  exportedNodes: SerializerNode[],
): Promise<{
  portalMarkers: SerializerPortalMarker[];
  crossProjectMarkers: SerializerCrossProjectMarker[];
}> {
  const exportedNodeIds = exportedNodes.map((n) => n.id);
  const hostTitleById = new Map(exportedNodes.map((n) => [n.id, n.title]));
  if (exportedNodeIds.length === 0) {
    return { portalMarkers: [], crossProjectMarkers: [] };
  }

  // Host-side reads in parallel — both scoped to the host project + the exported
  // node set, so a foreign node id can never smuggle in (set-membership posture).
  const [portalNodes, crossEdges] = await Promise.all([
    db.node.findMany({
      where: {
        id: { in: exportedNodeIds },
        projectId,
        deletedAt: null,
        embeddedProjectId: { not: null },
      },
      select: { id: true, title: true, embeddedProjectId: true },
    }),
    db.crossProjectEdge.findMany({
      where: {
        deletedAt: null,
        hostProjectId: projectId,
        hostNodeId: { in: exportedNodeIds },
      },
      select: {
        id: true,
        hostNodeId: true,
        foreignProjectId: true,
        foreignNodeId: true,
        interaction: true,
        label: true,
      },
    }),
  ]);

  if (portalNodes.length === 0 && crossEdges.length === 0) {
    return { portalMarkers: [], crossProjectMarkers: [] };
  }

  // Per-actor re-gate every distinct foreign project in PARALLEL (no waterfall),
  // building a Map of readable foreign project id → title. An unreadable project
  // is absent from the Map, so every marker keyed on it is dropped below.
  const distinctForeignProjectIds = [
    ...new Set([
      ...portalNodes
        .map((p) => p.embeddedProjectId)
        .filter((id): id is string => id !== null),
      ...crossEdges.map((e) => e.foreignProjectId),
    ]),
  ];
  const { readable: readableForeign } = await batchRegateReadable(
    db,
    actor,
    distinctForeignProjectIds,
  );
  const readableForeignTitles = new Map<string, string>();
  await Promise.all(
    [...readableForeign.keys()].map(async (foreignProjectId) => {
      const row = await db.project.findUnique({
        where: { id: foreignProjectId },
        select: { title: true },
      });
      if (row) readableForeignTitles.set(foreignProjectId, row.title);
    }),
  );

  const portalMarkers: SerializerPortalMarker[] = [];
  for (const p of portalNodes) {
    if (p.embeddedProjectId === null) continue;
    const foreignProjectTitle = readableForeignTitles.get(p.embeddedProjectId);
    if (foreignProjectTitle === undefined) continue; // unreadable → drop
    portalMarkers.push({
      hostNodeId: p.id,
      hostTitle: p.title,
      foreignProjectTitle,
    });
  }

  // ONE batch read of the surviving foreign endpoints' titles across every
  // readable foreign project — never a per-row follow-up.
  const survivingEdges = crossEdges.filter((e) =>
    readableForeignTitles.has(e.foreignProjectId),
  );
  const foreignTitleByNodeId = new Map<string, string>();
  if (survivingEdges.length > 0) {
    const foreignNodes = await db.node.findMany({
      where: {
        id: { in: survivingEdges.map((e) => e.foreignNodeId) },
        projectId: { in: [...readableForeignTitles.keys()] },
        deletedAt: null,
      },
      select: { id: true, title: true },
    });
    for (const n of foreignNodes) foreignTitleByNodeId.set(n.id, n.title);
  }

  const crossProjectMarkers: SerializerCrossProjectMarker[] = [];
  for (const e of survivingEdges) {
    const foreignProjectTitle = readableForeignTitles.get(e.foreignProjectId);
    const foreignEndpointTitle = foreignTitleByNodeId.get(e.foreignNodeId);
    // A dangling/soft-deleted foreign endpoint finds no title — drop the marker
    // (the same posture getCanvas takes for an unresolvable foreign node).
    if (foreignProjectTitle === undefined || foreignEndpointTitle === undefined) {
      continue;
    }
    crossProjectMarkers.push({
      hostNodeId: e.hostNodeId,
      hostTitle: hostTitleById.get(e.hostNodeId) ?? e.hostNodeId,
      foreignProjectTitle,
      foreignEndpointTitle,
      interaction: e.interaction,
      label: e.label,
    });
  }

  return { portalMarkers, crossProjectMarkers };
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
    actor,
    { projectId: project.id, projectTitle: project.title },
    { canvasNodeId, mode },
  );
}

/**
 * Renders a Project — or one of its subtrees — to deterministic markdown for the
 * member-aware MCP read path (#18, member parity #109). Unlike
 * {@link exportMarkdown}, the project is addressed by internal `projectId` (never
 * the slug) and the read resolves through the capability ladder (ADR-0040): the
 * bearer-token Actor reads a project it OWNS or is a MEMBER of, gated on `view`.
 *
 * `guestAccess` is deliberately forced to `NONE` on the token path: a token is a
 * userId-identified credential, never the anonymous slug-holder the guest grant
 * was defined for, so it must never read a `guestAccess=VIEW` project it is not a
 * member of. Read grant therefore equals the `listProjectsForActor` enumeration
 * (owner + member), and a leaked token's blast radius stays bounded to the
 * minting user's own and member projects (ADR-0040 #109).
 *
 * Fetch-then-authorize over already-loaded data (ADR-0001): the `findFirst`
 * filters `deletedAt: null` (soft-deleted → not-found) and pulls the actor's
 * membership row in the SAME query (no extra round trip). A deny resolves to
 * `NotFoundError` directly, mirroring the slug read seams so the service contract
 * is "not authorized == not found"; existence never leaks across the
 * non-disclosure boundary (ADR-0002/0040).
 */
export async function exportMarkdownForActor(
  db: Db,
  actor: Actor,
  input: McpReadInput,
): Promise<{ markdown: string }> {
  const { projectId, canvasNodeId, mode } = mcpReadInput.parse(input);

  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: {
      id: true,
      title: true,
      ownerId: true,
      memberships: {
        where: { userId: actor.userId },
        select: { role: true },
        take: 1,
      },
    },
  });
  if (!project) {
    throw new NotFoundError();
  }
  const cap = resolveCapability(
    actor,
    { ownerId: project.ownerId, guestAccess: "NONE" },
    project.memberships[0] ?? null,
  );
  if (!capabilityAtLeast(cap, "view")) {
    throw new NotFoundError();
  }

  return serializeProjectScope(
    db,
    actor,
    { projectId: project.id, projectTitle: project.title },
    { canvasNodeId, mode },
  );
}
