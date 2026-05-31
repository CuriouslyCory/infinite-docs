import type { Actor, Db } from "./actor";
import { NotFoundError } from "./errors";
import {
  exportMarkdownInput,
  type ExportMarkdownInput,
} from "~/lib/schemas";
import {
  serializeGraph,
  type SerializerBoundaryProxy,
  type SerializerEdge,
  type SerializerNode,
} from "./markdown";
import { type NodeKind as PrismaNodeKind } from "../../../generated/prisma/client";

/**
 * Renders a Project — or one of its subtrees — to deterministic markdown
 * (M2 / #15; ADR-0017).
 *
 * Authz: slug-readable (ADR-0002), the same posture `getCanvas` uses. The
 * slug→project bind below is the gate every raw query in this module
 * relies on; `actor` is accepted to match the readable-procedure
 * `(db, actor, input)` shape (ADR-0001) and is plumbed for a future
 * owner-gated mode (e.g. an MCP-token full-history export).
 *
 * Read shape — depth-independent, no waterfall (ADR-0001 single-round-trip):
 *
 *  - Whole project (`canvasNodeId === null`): two flat reads in parallel.
 *    Boundary is empty (the root has no ancestors).
 *  - Subtree (`canvasNodeId === R`): three reads in parallel. Two share the
 *    same descent CTE shape (one returns nodes, one returns edges scoped to
 *    any Canvas inside the subtree) — running them in parallel keeps the
 *    round trip flat at the cost of one extra recursive walk on the server,
 *    which is far cheaper than a second client → server round trip. The
 *    third is a leaner ancestry-walk CTE for the **boundary context**
 *    (same shape as `deriveBoundaryProxies` in `node.service.ts` /
 *    ADR-0012, without the Flow palette aggregation — Flows are #38's
 *    surface and would only inflate the payload).
 *
 * Serialization is delegated to the pure `serializeGraph` (no `db`, no
 * authz), which is the unit a future MCP read path (#18) reuses behind a
 * token gate.
 *
 * Raw-SQL discipline (ADR-0006): every identifier is double-quoted
 * PascalCase; the scope id and project id are bound parameters; user-
 * authored content is never interpolated.
 */

// Defensive bound on the descent / ancestry walks. The graph is a tree
// today (no `move`/reparent), so a cycle cannot occur; the cap is shared
// with `node.service.ts`'s `ANCESTRY_DEPTH_CAP` and bounds a future
// reparent feature, not a real nesting limit.
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
  canvasNodeId: string | null;
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

  let nodes: SerializerNode[];
  let edges: SerializerEdge[];
  let boundaryProxies: SerializerBoundaryProxy[];

  if (canvasNodeId === null) {
    const [nodeRows, edgeRows] = await Promise.all([
      db.node.findMany({
        where: { projectId: project.id, deletedAt: null },
        select: {
          id: true,
          parentId: true,
          title: true,
          kind: true,
          documentation: true,
        },
      }),
      db.edge.findMany({
        where: { projectId: project.id, deletedAt: null },
        select: {
          id: true,
          canvasNodeId: true,
          sourceId: true,
          targetId: true,
          label: true,
        },
      }),
    ]);
    nodes = nodeRows;
    edges = edgeRows.map((e) => ({
      id: e.id,
      canvasNodeId: e.canvasNodeId,
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
            AND n."projectId" = ${project.id}
            AND n."deletedAt" IS NULL
          UNION ALL
          SELECT c.id, c."parentId", c.title, c.kind, c.documentation, s.depth + 1
          FROM "Node" c
          JOIN subtree s ON c."parentId" = s.id
          WHERE c."projectId" = ${project.id}
            AND c."deletedAt" IS NULL
            AND s.depth < ${SUBTREE_DEPTH_CAP}
        )
        SELECT id, "parentId", title, kind, documentation FROM subtree`,
      db.$queryRaw<SubtreeEdgeRow[]>`
        WITH RECURSIVE subtree AS (
          SELECT n.id, n."parentId", 0 AS depth
          FROM "Node" n
          WHERE n.id = ${canvasNodeId}
            AND n."projectId" = ${project.id}
            AND n."deletedAt" IS NULL
          UNION ALL
          SELECT c.id, c."parentId", s.depth + 1
          FROM "Node" c
          JOIN subtree s ON c."parentId" = s.id
          WHERE c."projectId" = ${project.id}
            AND c."deletedAt" IS NULL
            AND s.depth < ${SUBTREE_DEPTH_CAP}
        )
        SELECT e.id, e."canvasNodeId", e."sourceId", e."targetId", e.label
        FROM "Edge" e
        JOIN subtree s ON e."canvasNodeId" = s.id
        WHERE e."projectId" = ${project.id}
          AND e."deletedAt" IS NULL`,
      db.$queryRaw<BoundaryRow[]>`
        WITH RECURSIVE ancestry AS (
          SELECT n.id, n."parentId", 0 AS depth
          FROM "Node" n
          WHERE n.id = ${canvasNodeId}
            AND n."projectId" = ${project.id}
            AND n."deletedAt" IS NULL
          UNION ALL
          SELECT p.id, p."parentId", a.depth + 1
          FROM "Node" p
          JOIN ancestry a ON p.id = a."parentId"
          WHERE p."projectId" = ${project.id}
            AND p."deletedAt" IS NULL
            AND a.depth < ${SUBTREE_DEPTH_CAP}
        )
        SELECT
          proxy.id AS node_id,
          proxy.title AS title,
          proxy.kind AS kind,
          BOOL_OR(a.depth = 0) AS is_direct
        FROM ancestry a
        JOIN "Edge" e
          ON e."canvasNodeId" IS NOT DISTINCT FROM a."parentId"
          AND e."deletedAt" IS NULL
          AND (e."sourceId" = a.id OR e."targetId" = a.id)
        JOIN "Node" proxy
          ON proxy.id = CASE
            WHEN e."sourceId" = a.id THEN e."targetId"
            ELSE e."sourceId"
          END
          AND proxy."deletedAt" IS NULL
        WHERE proxy.id NOT IN (SELECT id FROM ancestry)
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
      canvasNodeId: e.canvasNodeId,
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
    project: { title: project.title },
    rootCanvasNodeId: canvasNodeId,
    nodes,
    edges,
    boundaryProxies,
    mode,
  });

  return { markdown };
}
