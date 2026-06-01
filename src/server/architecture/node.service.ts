import { randomUUID } from "node:crypto";

import {
  type Edge,
  type FlowKind as PrismaFlowKind,
  type FlowInteraction as PrismaFlowInteraction,
  type Node,
  type NodeKind as PrismaNodeKind,
  type Prisma,
} from "../../../generated/prisma/client";
import { assertCanWrite } from "./access";
import type { Actor, Db } from "./actor";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import {
  isEdgeDedupCollision,
  isFlowDedupCollision,
  isFlowRouteDedupCollision,
} from "./prisma-errors";
import {
  createNodeInput,
  deleteNodeInput,
  getCanvasInput,
  moveNodeInput,
  restoreNodeInput,
  updateNodeDocumentationInput,
  updateNodeInput,
  updateNodeKindInput,
  updatePositionsInput,
  type CreateNodeInput,
  type DeleteNodeInput,
  type GetCanvasInput,
  type MoveNodeInput,
  type NodeKind,
  type RestoreNodeInput,
  type UpdateNodeDocumentationInput,
  type UpdateNodeInput,
  type UpdateNodeKindInput,
  type UpdatePositionsInput,
} from "~/lib/schemas";

// Compile-time parity guard: the client-safe Zod `nodeKind` enum (~/lib/schemas)
// and the Prisma `NodeKind` enum must describe the same value set. If either side
// gains or loses a member, one of these typed maps stops type-checking and
// `pnpm check` fails — turning "keep the two enums in sync" from a remembered
// discipline into a checked invariant (CONTEXT.md "Component kind"). This guard
// lives server-side precisely because importing the Prisma enum is the leak we
// forbid in client code (ADR-0004); the client only ever sees the Zod enum.
const _zodKindIsPrismaKind: Record<NodeKind, PrismaNodeKind> = {
  GENERIC: "GENERIC",
  GLOBAL_INFRA: "GLOBAL_INFRA",
  REGION: "REGION",
  DATACENTER: "DATACENTER",
  NETWORK: "NETWORK",
  HOST: "HOST",
  CONTAINER: "CONTAINER",
  SERVICE: "SERVICE",
  MICROSERVICE: "MICROSERVICE",
  CRON: "CRON",
  QUEUE: "QUEUE",
  APPLICATION: "APPLICATION",
  MODULE: "MODULE",
  CLASS: "CLASS",
  FUNCTION: "FUNCTION",
  VARIABLE: "VARIABLE",
  BRANCH: "BRANCH",
  DATABASE: "DATABASE",
  TABLE: "TABLE",
  STORED_PROCEDURE: "STORED_PROCEDURE",
  EXTERNAL_API: "EXTERNAL_API",
  ENDPOINT: "ENDPOINT",
  WEBHOOK: "WEBHOOK",
  TOPIC: "TOPIC",
  CONSUMER: "CONSUMER",
  PRODUCER: "PRODUCER",
};
const _prismaKindIsZodKind: Record<PrismaNodeKind, NodeKind> = {
  GENERIC: "GENERIC",
  GLOBAL_INFRA: "GLOBAL_INFRA",
  REGION: "REGION",
  DATACENTER: "DATACENTER",
  NETWORK: "NETWORK",
  HOST: "HOST",
  CONTAINER: "CONTAINER",
  SERVICE: "SERVICE",
  MICROSERVICE: "MICROSERVICE",
  CRON: "CRON",
  QUEUE: "QUEUE",
  APPLICATION: "APPLICATION",
  MODULE: "MODULE",
  CLASS: "CLASS",
  FUNCTION: "FUNCTION",
  VARIABLE: "VARIABLE",
  BRANCH: "BRANCH",
  DATABASE: "DATABASE",
  TABLE: "TABLE",
  STORED_PROCEDURE: "STORED_PROCEDURE",
  EXTERNAL_API: "EXTERNAL_API",
  ENDPOINT: "ENDPOINT",
  WEBHOOK: "WEBHOOK",
  TOPIC: "TOPIC",
  CONSUMER: "CONSUMER",
  PRODUCER: "PRODUCER",
};
void _zodKindIsPrismaKind;
void _prismaKindIsZodKind;

/**
 * Creates a Component (a Node) on a Canvas scope within a Project. The scope is
 * `parentId`: null is the Project's root Canvas, otherwise the id of the
 * containing Component — which, when non-null, must be a live Node in this same
 * Project (a child Component cannot hang off a missing, soft-deleted, or
 * foreign-Project parent). `kind` is cosmetic (icon/color only — CONTEXT.md
 * "Component kind"); `posX`/`posY` are the drop point.
 *
 * Owner-only: the Project is addressed by `projectId` (an internal handle, never
 * the capability slug — writes are never slug-granted, ADR-0002) and the write
 * is authorized through `access.assertCanWrite` against `project.ownerId`.
 * Ownership comes from the actor, never from `input` (ADR-0001).
 *
 * `title` (and later `documentation`) are UNTRUSTED user content, stored verbatim
 * — never interpreted, never interpolated into a query (prompt-injection standing
 * note, CONTEXT.md).
 */
export async function createNode(
  db: Db,
  actor: Actor,
  input: CreateNodeInput,
): Promise<Node> {
  const { projectId, parentId, kind, title, posX, posY } =
    createNodeInput.parse(input);

  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  // A child Component (parentId !== null) must hang off a live parent Node in
  // this same owned Project. Scoping the lookup to `project.id` closes
  // cross-project nesting smuggling (a foreign parent id can never be used) and
  // never reveals whether the id exists elsewhere — the same set-membership
  // posture `connectNodes`/`updatePositions` use for their endpoint checks. A
  // missing / soft-deleted / foreign parent surfaces as not-found (the input
  // shape is valid; the referenced parent is absent), never a partial write.
  if (parentId !== null) {
    const parent = await db.node.findFirst({
      where: { id: parentId, projectId: project.id, deletedAt: null },
      select: { id: true },
    });
    if (!parent) {
      throw new NotFoundError();
    }
  }

  return db.node.create({
    data: { projectId: project.id, parentId, kind, title, posX, posY },
  });
}

/**
 * Materializes a Canvas for a scope: its interior Components (Nodes whose
 * `parentId` is the scope) and Connections (Edges whose `canvasNodeId` is the
 * scope), per the Canvas derivation in CONTEXT.md. Addressed by the capability
 * `slug` (the read grant, ADR-0002), so it works without a session.
 *
 * Interior Nodes, interior Edges, and the breadcrumb trail are independent, so
 * they are fetched concurrently — one round-trip's depth, no waterfall (the
 * perf model, PRD). The result is named in Node/Edge terms even though users
 * see "the interior Components and Connections" (the Component/Node +
 * Connection/Edge split).
 *
 * `breadcrumbs` is the ordered ancestor chain (root -> current scope, the
 * current scope included) computed in a SINGLE recursive CTE, never a per-level
 * walk (ADR-0006). The root scope (`canvasNodeId === null`) has no ancestors and
 * returns `[]`. A non-null scope that resolves to no live Node in this Project
 * (missing / soft-deleted / cross-project) is a not-found — detected by an empty
 * breadcrumb trail, NOT by an empty interior (an empty interior is a legitimate
 * leaf Component). `boundaryProxies` joins this payload with boundary derivation
 * (M3).
 *
 * NOTE: the breadcrumb query is raw SQL — the first in the repo. Postgres folds
 * unquoted identifiers to lowercase, so every model/column name is double-quoted
 * PascalCase (`"Node"`, `"parentId"`, ...); the scope id and project id are
 * bound parameters, never string-interpolated. See ADR-0006.
 */
// Shape of an `interiorNode` in the `getCanvas` payload: the Node plus the
// `_count.flows` aggregate that drives the "N flows" pill on the Component
// body. Folded into the same `findMany` so the count costs no extra round
// trip (ADR-0001 single-round-trip read; ADR-0011 — Flow as first-class).
export type CanvasInteriorNode = Prisma.NodeGetPayload<{
  include: { _count: { select: { flows: true } } };
}>;

// Per-Edge Flow aggregation that drives the "N / M routed" pill on a
// Connection (Slice 2 of flow-routed-connections). One entry per interior
// Edge on the requested Canvas scope; missing Edges (no Flows touching, no
// FlowRoutes) get a zero entry so the UI never has to defend against an
// absent key.
//
// - `total` = active Flows whose owner is either endpoint of the Edge (LOOSE:
//   any owner-endpoint Flow can ride a Connection, so this is the full set;
//   ADR-0023).
// - `routed` = active FlowRoutes with this Edge as `outerEdgeId` and a live
//   Flow.
// - `unrouted` = `total - routed`.
// - `orphan` = active FlowRoutes with this Edge as `outerEdgeId` whose Flow
//   is soft-deleted (re-parse fallout — the Flow's spec dropped its key,
//   the route hangs visibly rather than vanishing silently; ADR-0011).
// - `byKind` = per-`FlowKind` count of the `routed` set only.
// - `arrowAtSource` / `arrowAtTarget` = how many live routed Flows point their
//   arrow at the Edge's stored `source` / `target` endpoint, derived per Flow
//   from `(owner, interaction)` — the canonical rule is `~/lib/flow-direction`
//   `flowArrowEndpoints`, mirrored in the aggregation SQL. The client renders a
//   `markerStart` when `arrowAtSource > 0` and a `markerEnd` when
//   `arrowAtTarget > 0`; both → a two-way (WebSocket) Connection, neither → an
//   undirected line. Counts (not booleans) so the optimistic route/unroute
//   delta is inverse-safe under concurrent edits (ADR-0023).
export interface EdgeFlowsEntry {
  edgeId: string;
  total: number;
  routed: number;
  unrouted: number;
  orphan: number;
  byKind: Partial<Record<PrismaFlowKind, number>>;
  arrowAtSource: number;
  arrowAtTarget: number;
}

// A boundary proxy on the requested Canvas scope (M3 / #13): a read-only
// stand-in for an external Component this scope (or an ancestor) connects to on
// its parent Canvas, projected inward. Derived transitively, never persisted —
// `boundary(H) = directBoundary(H) ∪ boundary(H.parent)`.
//
// - `origin: "direct"` — an external the CURRENT scope's Component connects to
//   on its own parent Canvas. `"inherited"` — projected down from an ancestor.
//   Drives the collapse/group UX (#14): inherited proxies fold away to keep a
//   deep Canvas uncluttered.
export interface BoundaryProxyEntry {
  nodeId: string;
  title: string;
  kind: PrismaNodeKind;
  origin: "direct" | "inherited";
  // The incident outer Connection between the current scope's Component and this
  // proxy on the scope's parent Canvas — the single Edge a palette drag refines
  // (Slice 3 / ADR-0012). A Connection is undirected, so there is exactly one per
  // pair regardless of which way it was drawn, and any Flow rides it regardless
  // of its interaction (ADR-0023 retired the orientation split and the
  // reverse-Connection offer). Non-null only for `origin: "direct"` proxies (a
  // refinement binds an Edge incident to the current scope); null = inherited or
  // unconnected. (When several Connections somehow share the pair — impossible
  // under the unordered de-dupe — the lexically-first id is chosen.)
  outerEdgeId: string | null;
}

// One Flow as the boundary-proxy palette renders it (Slice 3 / ADR-0012). A
// lean projection of `Flow` — the palette needs identity, render labels, and
// the interaction verb that drives its arrow direction, not the full
// `signature` Json. `getCanvas` bundles the first `FLOW_PALETTE_PAGE_SIZE` per
// in-scope proxy; the rest page in through `getFlowPalette`.
export interface FlowPaletteItem {
  id: string;
  ownerNodeId: string;
  kind: PrismaFlowKind;
  key: string;
  title: string;
  interaction: PrismaFlowInteraction;
}

export interface FlowPalette {
  flows: FlowPaletteItem[];
  // `true` when the owner has more active Flows than the bundled page — the
  // inspector pages the remainder in via `getFlowPalette`.
  hasMore: boolean;
}

// First page of a boundary proxy's Flow palette bundled into `getCanvas`. The
// worst case (a 200-operation OpenAPI spec) ships 50 here and the rest behind
// `hasMore` — the bundled read stays O(boundary proxies on this scope), never
// O(project) (master plan perf posture).
export const FLOW_PALETTE_PAGE_SIZE = 50;

// Bound on the ancestry walk shared by the breadcrumb and boundary-derivation
// CTEs. The graph is acyclic — `moveNode` owns cycle prevention (ADR-0024,
// rejecting any reparent whose new parent sits in the moving subtree) — so the
// cap is not the only defense against unbounded recursion; it ALSO bounds
// legitimate nesting. Rather than silently truncate a trail (or a proxy set)
// past the cap, `getCanvas` detects a walk that reached the ceiling and throws
// (see the truncation check below) so the limit surfaces as a loud, typed error
// instead of missing data. 256 is far past any real architecture nesting;
// hitting it means a regression in cycle prevention or pathological depth, both
// of which a viewer should be told about, not handed a quietly-incomplete
// Canvas.
const ANCESTRY_DEPTH_CAP = 256;

// Raw shape of one row from the boundary-derivation query. `palette` is a
// Postgres `json` column (parsed to a JS array by the pg adapter) holding up to
// FLOW_PALETTE_PAGE_SIZE + 1 items so the caller can compute `hasMore`.
interface BoundaryProxyRow {
  node_id: string;
  title: string;
  kind: PrismaNodeKind;
  is_direct: boolean;
  outer_edge_id: string | null;
  palette: FlowPaletteItem[];
}

/**
 * Derives the boundary proxies and their first-page Flow palettes for a scope in
 * ONE recursive-CTE round trip (ADR-0012 / #13 / #14). Walks the ancestor chain
 * from `canvasNodeId` to the root; for each ancestor `a` it pulls the Edges on
 * `a`'s parent Canvas incident to `a` and takes the OTHER endpoint as a boundary
 * proxy. `is_direct` (depth 0) marks the scope's own externals — routable here,
 * carrying the single incident outer Edge id (ADR-0023) — vs inherited ones
 * (#14). Each proxy's palette is a
 * correlated `json_agg` of its first FLOW_PALETTE_PAGE_SIZE + 1 active Flows (+1
 * reveals `hasMore`). The root scope has no ancestors, so it has no proxies.
 *
 * CALLER MUST HAVE AUTHORIZED `projectId` — this helper takes no Actor and does
 * NO authorization of its own. It is a private read-side projection; the
 * slug→project bind in `getCanvas` is the gate (ADR-0002). A future caller (a
 * Slice-4 polarity reconciler, an admin/MCP read) that invokes it without first
 * resolving and authorizing the project would walk ancestry across whatever
 * `projectId` it is handed. Keep it private to this module.
 */
async function deriveBoundaryProxies(
  db: Db,
  projectId: string,
  canvasNodeId: string | null,
): Promise<BoundaryProxyRow[]> {
  if (canvasNodeId === null) {
    return [];
  }
  return db.$queryRaw<BoundaryProxyRow[]>`
    WITH RECURSIVE ancestry AS (
      SELECT n.id, n."parentId", 0 AS depth
      FROM "Node" n
      WHERE n.id = ${canvasNodeId}
        AND n."projectId" = ${projectId}
        AND n."deletedAt" IS NULL
      UNION ALL
      SELECT p.id, p."parentId", a.depth + 1
      FROM "Node" p
      JOIN ancestry a ON p.id = a."parentId"
      WHERE p."projectId" = ${projectId}
        AND p."deletedAt" IS NULL
        AND a.depth < ${ANCESTRY_DEPTH_CAP}
    )
    SELECT
      proxy.id AS node_id,
      proxy.title AS title,
      proxy.kind AS kind,
      BOOL_OR(a.depth = 0) AS is_direct,
      MIN(CASE WHEN a.depth = 0 THEN e.id END) AS outer_edge_id,
      (
        SELECT COALESCE(
          json_agg(
            json_build_object(
              'id', pf.id,
              'ownerNodeId', pf."ownerNodeId",
              'kind', pf.kind,
              'key', pf.key,
              'title', pf.title,
              'interaction', pf.interaction
            )
            ORDER BY pf."createdAt"
          ),
          '[]'::json
        )
        FROM (
          SELECT f.id, f."ownerNodeId", f.kind, f.key, f.title,
                 f.interaction, f."createdAt"
          FROM "Flow" f
          WHERE f."ownerNodeId" = proxy.id AND f."deletedAt" IS NULL
          ORDER BY f."createdAt" ASC
          LIMIT ${FLOW_PALETTE_PAGE_SIZE + 1}
        ) pf
      ) AS palette
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
    GROUP BY proxy.id, proxy.title, proxy.kind
    ORDER BY BOOL_OR(a.depth = 0) DESC, proxy.title ASC`;
}

/**
 * Reads everything one Canvas scope needs in a single round trip (ADR-0001):
 * interior Components + Connections, the per-Edge Flow aggregation, the boundary
 * proxies and their first-page palettes, and the breadcrumb trail.
 *
 * Slug-readable (ADR-0002): the capability slug IS the read grant, so `actor` is
 * not consulted — it is accepted only to match the readable-procedure signature
 * shape (`db, actor, input`) shared with `getFlowsForNode` / `getFlowPalette`,
 * and is plumbed for a future owner-gated field. The slug→project bind below is
 * the authorization gate every raw query (including `deriveBoundaryProxies`)
 * relies on.
 */
export async function getCanvas(
  db: Db,
  _actor: Actor | null,
  input: GetCanvasInput,
): Promise<{
  interiorNodes: CanvasInteriorNode[];
  interiorEdges: Edge[];
  edgeFlows: EdgeFlowsEntry[];
  boundaryProxies: BoundaryProxyEntry[];
  flowPalettes: Record<string, FlowPalette>;
  breadcrumbs: { id: string; title: string; kind: NodeKind }[];
}> {
  const { slug, canvasNodeId } = getCanvasInput.parse(input);

  const project = await db.project.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true },
  });
  if (!project) {
    throw new NotFoundError();
  }

  // All four reads run in one `Promise.all` — no per-Edge waterfall, no
  // dependency on `interiorEdges` resolving first (the Flow aggregations
  // filter directly on projectId + canvasNodeId via JOIN to Edge). One
  // round-trip's depth (ADR-0001 / ADR-0006).
  //
  // The two FlowRoute aggregations are raw SQL because:
  //   1. `orphan` requires joining FlowRoute to Flow INCLUDING soft-deleted
  //      Flow rows — Prisma's `findMany` with relations defaults to
  //      filtering `deletedAt: null`, which would erase the orphan signal.
  //   2. `IS NOT DISTINCT FROM` is needed for `canvasNodeId` because the
  //      root Canvas's scope is null — a plain `=` against null is falsy
  //      and root-Canvas edges would be silently filtered out. Same trap
  //      `idx_edge_dedup`'s `NULLS NOT DISTINCT` documents (ADR-0010).
  const [
    interiorNodes,
    interiorEdges,
    breadcrumbs,
    routeRows,
    totalRows,
    boundaryRows,
  ] = await Promise.all([
      db.node.findMany({
        where: { projectId: project.id, parentId: canvasNodeId, deletedAt: null },
        orderBy: { createdAt: "asc" },
        // Active Flow count per Node — drives the "N flows" pill on the
        // Component body. `where: { deletedAt: null }` on the relation count
        // excludes soft-deleted Flows, so the pill reflects what the user
        // sees in the Flow palette (ADR-0011).
        include: {
          _count: { select: { flows: { where: { deletedAt: null } } } },
        },
      }),
      db.edge.findMany({
        where: { projectId: project.id, canvasNodeId, deletedAt: null },
        orderBy: { createdAt: "asc" },
      }),
      // The breadcrumb trail walks `parentId` from the scope up to the root
      // in one recursive CTE (ADR-0006). At the root scope there are no
      // ancestors, so we skip the query entirely. The `ANCESTRY_DEPTH_CAP`
      // bound is belt-and-suspenders against cycle-prevention regressions
      // (`moveNode` owns prevention today, ADR-0024) and a real depth cap; a
      // walk that reaches it is detected below and throws rather than
      // returning a silently-truncated trail.
      canvasNodeId === null
        ? Promise.resolve<{ id: string; title: string; kind: NodeKind }[]>([])
        : db.$queryRaw<{ id: string; title: string; kind: NodeKind }[]>`
            WITH RECURSIVE ancestry AS (
              SELECT n.id, n.title, n.kind, n."parentId", 0 AS depth
              FROM "Node" n
              WHERE n.id = ${canvasNodeId}
                AND n."projectId" = ${project.id}
                AND n."deletedAt" IS NULL
              UNION ALL
              SELECT p.id, p.title, p.kind, p."parentId", a.depth + 1
              FROM "Node" p
              JOIN ancestry a ON p.id = a."parentId"
              WHERE p."projectId" = ${project.id}
                AND p."deletedAt" IS NULL
                AND a.depth < ${ANCESTRY_DEPTH_CAP}
            )
            SELECT id, title, kind FROM ancestry ORDER BY depth DESC`,
      // Route aggregation: routed + orphan + byKind per outer Edge on this
      // Canvas. JOIN to Flow keeps soft-deleted rows so orphan detection
      // works; `is_orphan` flags them. byKind is the kind of every active
      // route (orphan rows excluded — their Flow's kind is on a dead row,
      // displaying it would mislead the user about what's live).
      db.$queryRaw<
        {
          edge_id: string;
          flow_kind: PrismaFlowKind;
          is_orphan: boolean;
          n: bigint;
          arrow_at_source: bigint;
          arrow_at_target: bigint;
        }[]
      >`
        SELECT
          fr."outerEdgeId" AS edge_id,
          f.kind AS flow_kind,
          (f."deletedAt" IS NOT NULL) AS is_orphan,
          COUNT(*)::bigint AS n,
          -- Arrow direction per live routed Flow, derived from (owner,
          -- interaction). Mirrors flowArrowEndpoints in src/lib/flow-direction
          -- (the canonical rule): REQUEST/SUBSCRIBE point at the owner,
          -- PUSH points away, DUPLEX both. Summed here, folded across kinds
          -- per edge in JS; only the non-orphan rows contribute (ADR-0023).
          SUM(CASE WHEN
            (f."ownerNodeId" = e."sourceId" AND f.interaction IN ('REQUEST', 'SUBSCRIBE', 'DUPLEX'))
            OR (f."ownerNodeId" = e."targetId" AND f.interaction IN ('PUSH', 'DUPLEX'))
          THEN 1 ELSE 0 END)::bigint AS arrow_at_source,
          SUM(CASE WHEN
            (f."ownerNodeId" = e."sourceId" AND f.interaction IN ('PUSH', 'DUPLEX'))
            OR (f."ownerNodeId" = e."targetId" AND f.interaction IN ('REQUEST', 'SUBSCRIBE', 'DUPLEX'))
          THEN 1 ELSE 0 END)::bigint AS arrow_at_target
        FROM "FlowRoute" fr
        JOIN "Edge" e ON e.id = fr."outerEdgeId"
        JOIN "Flow" f ON f.id = fr."flowId"
        WHERE e."projectId" = ${project.id}
          AND e."canvasNodeId" IS NOT DISTINCT FROM ${canvasNodeId}
          AND e."deletedAt" IS NULL
          AND fr."deletedAt" IS NULL
        GROUP BY fr."outerEdgeId", f.kind, (f."deletedAt" IS NOT NULL)`,
      // Total per Edge: distinct active Flows whose owner is either
      // endpoint of the Edge. Loose definition — no polarity filter, Slice
      // 4 tightens (ADR-0013). DISTINCT because a single Flow could
      // structurally be owned by both endpoints if a self-link were
      // allowed; today self-links are forbidden (ADR-0005) but DISTINCT
      // keeps the count honest under future relaxations.
      db.$queryRaw<{ edge_id: string; n: bigint }[]>`
        SELECT
          e.id AS edge_id,
          COUNT(DISTINCT f.id)::bigint AS n
        FROM "Edge" e
        JOIN "Flow" f
          ON f."ownerNodeId" IN (e."sourceId", e."targetId")
        WHERE e."projectId" = ${project.id}
          AND e."canvasNodeId" IS NOT DISTINCT FROM ${canvasNodeId}
          AND e."deletedAt" IS NULL
          AND f."deletedAt" IS NULL
        GROUP BY e.id`,
      // Boundary proxies + their Flow palettes for this scope (M3 / #13 +
      // Slice 3 / ADR-0012), in ONE statement so the single-round-trip read
      // holds (ADR-0001). Extracted to `deriveBoundaryProxies` (which carries
      // the authorization contract); the slug→project bind above is its gate.
      deriveBoundaryProxies(db, project.id, canvasNodeId),
    ]);

  // A walk that reached the depth ceiling returns a silently-truncated trail
  // (and proxy set). Surface it as a typed error rather than handing back a
  // quietly-incomplete Canvas — see `ANCESTRY_DEPTH_CAP`. The recursive CTE
  // emits depths 0..CAP, so a full walk is CAP + 1 rows; anything beyond means
  // the ceiling clipped it. (The graph is a tree today, so this is unreachable
  // short of pathological nesting; it becomes live cycle-defense once reparent
  // lands. Defensive guard — not pinned by a contrived deep-chain test, per the
  // ADR-0014 precedent / Philosophy #6.)
  if (breadcrumbs.length > ANCESTRY_DEPTH_CAP) {
    throw new ValidationError(
      "This Canvas is nested too deeply to display.",
    );
  }

  // A non-null scope with no breadcrumbs never resolved to a live Node in
  // this Project. Key off the breadcrumb trail (a live scope always returns
  // its own row at depth 0), never the interior count — an empty interior
  // is a valid leaf Canvas. The root scope is exempt: it has no Component
  // to resolve.
  if (canvasNodeId !== null && breadcrumbs.length === 0) {
    throw new NotFoundError();
  }

  // Merge the two aggregations keyed by edge_id. Every interior Edge gets
  // an entry (zero-valued when neither aggregation produced a row), so the
  // client never needs to defend against a missing key.
  const edgeFlowsByEdge = new Map<string, EdgeFlowsEntry>();
  for (const edge of interiorEdges) {
    edgeFlowsByEdge.set(edge.id, {
      edgeId: edge.id,
      total: 0,
      routed: 0,
      unrouted: 0,
      orphan: 0,
      byKind: {},
      arrowAtSource: 0,
      arrowAtTarget: 0,
    });
  }
  for (const row of routeRows) {
    const entry = edgeFlowsByEdge.get(row.edge_id);
    if (!entry) continue;
    const count = Number(row.n);
    if (row.is_orphan) {
      entry.orphan += count;
    } else {
      entry.routed += count;
      entry.byKind[row.flow_kind] = (entry.byKind[row.flow_kind] ?? 0) + count;
      // Arrowheads count only live routed Flows; an orphan's Flow is gone, so
      // its (dead) interaction must not steer the rendered direction (ADR-0023).
      entry.arrowAtSource += Number(row.arrow_at_source);
      entry.arrowAtTarget += Number(row.arrow_at_target);
    }
  }
  for (const row of totalRows) {
    const entry = edgeFlowsByEdge.get(row.edge_id);
    if (!entry) continue;
    entry.total = Number(row.n);
  }
  for (const entry of edgeFlowsByEdge.values()) {
    // `unrouted` is `total - routed`, floored at 0 — a Flow whose route was
    // soft-deleted but whose owner is still an endpoint stays counted in
    // `total` and stays "unrouted" once `routed` drops. Orphan does NOT
    // count against `total` (the Flow itself is gone) so it doesn't push
    // `unrouted` negative.
    //
    // The floor never actually fires today: `routeFlow` requires the Flow's
    // owner to be an endpoint, so every routed live Flow is also counted in
    // `total` (routed <= total always). It guards a case a later slice
    // introduces — a routed Flow whose owner is NO LONGER an endpoint (Slice
    // 3 inner-edge routing, or a future reparent/move) — so don't read it as
    // dead defense and remove it.
    entry.unrouted = Math.max(0, entry.total - entry.routed);
  }
  const edgeFlows = interiorEdges.map(
    (e) => edgeFlowsByEdge.get(e.id) ?? {
      edgeId: e.id,
      total: 0,
      routed: 0,
      unrouted: 0,
      orphan: 0,
      byKind: {},
      arrowAtSource: 0,
      arrowAtTarget: 0,
    },
  );

  // Split the one boundary query into the two payload fields: the proxy list
  // (#13/#14) and the per-proxy palette map (Slice 3). The query bundled
  // FLOW_PALETTE_PAGE_SIZE + 1 Flows per proxy, so an over-long page reveals
  // `hasMore` and is trimmed to the page size; the rest page in via
  // `getFlowPalette`.
  const boundaryProxies: BoundaryProxyEntry[] = [];
  const flowPalettes: Record<string, FlowPalette> = {};
  for (const row of boundaryRows) {
    boundaryProxies.push({
      nodeId: row.node_id,
      title: row.title,
      kind: row.kind,
      origin: row.is_direct ? "direct" : "inherited",
      outerEdgeId: row.outer_edge_id,
    });
    const items = row.palette ?? [];
    const hasMore = items.length > FLOW_PALETTE_PAGE_SIZE;
    flowPalettes[row.node_id] = {
      flows: (hasMore ? items.slice(0, FLOW_PALETTE_PAGE_SIZE) : items).map(
        (f) => ({
          id: f.id,
          ownerNodeId: f.ownerNodeId,
          kind: f.kind,
          key: f.key,
          title: f.title,
          interaction: f.interaction,
        }),
      ),
      hasMore,
    };
  }

  return {
    interiorNodes,
    interiorEdges,
    edgeFlows,
    boundaryProxies,
    flowPalettes,
    breadcrumbs,
  };
}

/**
 * Renames a Component (updates a Node's `title`). Addressed by the Node `id`,
 * not a projectId: the Node is loaded, its Project resolved, and the write
 * authorized owner-only through `access.assertCanWrite` against the Project's
 * `ownerId` (ADR-0001). Load-then-authorize is the natural shape for an existing
 * row and matches how a future MCP "rename" tool arrives — it holds a node id,
 * not a project handle. Ownership comes from the actor, never from `input`.
 *
 * `title` is UNTRUSTED user content, stored verbatim — never interpreted, never
 * interpolated into a query (prompt-injection standing note, CONTEXT.md). Rename
 * makes the title mutable after a viewer has loaded the Canvas, but that changes
 * nothing for the standing note: defenses live at the serialization/MCP output
 * boundary (a later milestone).
 */
export async function updateNode(
  db: Db,
  actor: Actor,
  input: UpdateNodeInput,
): Promise<Node> {
  const { id, title } = updateNodeInput.parse(input);

  const node = await db.node.findFirst({ where: { id, deletedAt: null } });
  if (!node) {
    throw new NotFoundError();
  }
  const project = await db.project.findFirst({
    where: { id: node.projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  return db.node.update({ where: { id: node.id }, data: { title } });
}

/**
 * Changes a Component's `kind`. Same load-then-authorize shape as `updateNode`
 * (find the live Node, resolve its Project, authorize owner-only via
 * `access.assertCanWrite`; ADR-0001) — a separate narrow mutation so the kind
 * palette commits only `{ id, kind }`. Ownership comes from the actor, never
 * `input`.
 *
 * Kind is cosmetic (CONTEXT.md "Component kind"; ADR-0018): this is a single
 * `kind` write with NO cascade — no Edge, Flow, or FlowRoute is touched, because
 * none of them depend on kind. Any `kind` is accepted regardless of the parent's
 * kind: affinity ranks the picker, it does not constrain the write (ADR-0019).
 */
export async function updateNodeKind(
  db: Db,
  actor: Actor,
  input: UpdateNodeKindInput,
): Promise<Node> {
  const { id, kind } = updateNodeKindInput.parse(input);

  const node = await db.node.findFirst({ where: { id, deletedAt: null } });
  if (!node) {
    throw new NotFoundError();
  }
  const project = await db.project.findFirst({
    where: { id: node.projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  return db.node.update({ where: { id: node.id }, data: { kind } });
}

/**
 * Edits a Component's markdown `documentation`. Same load-then-authorize shape
 * as `updateNode` (find the live Node, resolve its Project, authorize owner-only
 * via `access.assertCanWrite`; ADR-0001) — a separate narrow mutation so the
 * canvas autosave commits only `{ id, documentation }` per debounced keystroke
 * without re-sending the title. Ownership comes from the actor, never `input`.
 *
 * `documentation` is UNTRUSTED user content, stored verbatim — never
 * interpreted, never interpolated into a query (prompt-injection standing note,
 * CONTEXT.md). The empty string is a valid value (clears the docs). Defenses for
 * feeding this content to an LLM live at the serialization/MCP output boundary
 * (a later milestone), not here.
 */
export async function updateNodeDocumentation(
  db: Db,
  actor: Actor,
  input: UpdateNodeDocumentationInput,
): Promise<Node> {
  const { id, documentation } = updateNodeDocumentationInput.parse(input);

  const node = await db.node.findFirst({ where: { id, deletedAt: null } });
  if (!node) {
    throw new NotFoundError();
  }
  const project = await db.project.findFirst({
    where: { id: node.projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  return db.node.update({ where: { id: node.id }, data: { documentation } });
}

/**
 * Reparents a Component to a new Canvas scope. Same load-then-authorize shape
 * as the other narrow Node mutations; the new scope is `parentId` (null = the
 * Project root; a Node id = that Component's interior Canvas). Ownership comes
 * from the actor, never `input` (ADR-0001). The MCP `move_component` tool is
 * the canonical caller; there is no web/tRPC counterpart yet.
 *
 * Structural but deliberately NON-cascading (ADR-0024) — two rejects keep the
 * graph honest:
 *
 * 1. CYCLE → {@link ValidationError}. The new parent must not be the Node
 *    itself or any of its descendants. We compute the subtree of `node` (the
 *    recursive `parentId` walk `deleteNode` uses) and reject when `parentId`
 *    falls inside it — depth-0 self-parent and any deeper ancestor-onto-
 *    descendant case in one shot. BAD_REQUEST, not CONFLICT: the request is
 *    malformed for THIS node; no state change makes it valid.
 *
 * 2. ORPHANING incident Connections → {@link ConflictError} with
 *    `details.conflictingEdgeIds`. The same-Canvas invariant (ADR-0005) held
 *    BEFORE the move, so the Component's incident Edges all sit on the old
 *    Canvas (`canvasNodeId = oldParentId`). Moving the Component leaves them
 *    dangling. Rather than silently rescope or sever (philosophy #6 — never
 *    "turn off the rule to pass"), reject and tell the agent to disconnect
 *    first. The structured details are the AI-readable self-correction
 *    channel (ADR-0010 named pattern, the same posture `connectNodes` /
 *    `restoreEdge` use).
 *
 * Cross-scope FlowRoutes are SAFE under move today (ADR-0024 "Considered: a
 * refinement FlowRoute"). `routeFlow` constrains the boundary endpoint to be
 * an endpoint of the outer Edge, and `connectNodes` keeps outer Edges
 * same-Canvas; together those force the boundary endpoint and the inner
 * Edge's `canvasNodeId` scope to share a parent — so whenever the inner
 * Edge's scope rides into the moving subtree, the boundary endpoint rides
 * with it. The route stays self-consistent and no falsification check is
 * needed at this layer. If a future writer loosens these constraints (e.g.
 * deeper refinement nesting), this is where the additional reject lands.
 *
 * Idempotent: a move to the current parent is a no-op (returns the node
 * unchanged). Atomicity: this function makes multiple reads plus one write,
 * so the caller MUST wrap it in `db.$transaction` (the MCP tool handler
 * does) — a concurrent `connectNodes` could otherwise commit an incident
 * Edge between the orphan check and the parentId write.
 *
 * See ADR-0024 (the reject decision and the cross-scope analysis) and
 * ADR-0005 (the same-Canvas invariant the rejects preserve).
 */
export async function moveNode(
  db: Db,
  actor: Actor,
  input: MoveNodeInput,
): Promise<Node> {
  const { id, parentId } = moveNodeInput.parse(input);

  const node = await db.node.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, projectId: true, parentId: true },
  });
  if (!node) {
    throw new NotFoundError();
  }
  const project = await db.project.findFirst({
    where: { id: node.projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  // Idempotent: a move that doesn't change `parentId` is a no-op. Return the
  // full Node row so the caller's optimistic UI / tool result still has it.
  if (parentId === node.parentId) {
    const current = await db.node.findUnique({ where: { id: node.id } });
    if (!current) {
      throw new NotFoundError();
    }
    return current;
  }

  // The new parent must be a live Node in this same owned Project. Mirrors
  // `createNode`'s child posture: a missing / soft-deleted / foreign-project
  // parent surfaces as not-found.
  if (parentId !== null) {
    const parent = await db.node.findFirst({
      where: { id: parentId, projectId: node.projectId, deletedAt: null },
      select: { id: true },
    });
    if (!parent) {
      throw new NotFoundError();
    }
  }

  // The moving subtree (root included), for the cycle check. Same recursive
  // walk `deleteNode` uses; the graph is acyclic — this function owns
  // prevention — so the recursion terminates. Bound params only;
  // double-quoted PascalCase identifiers because Postgres folds unquoted
  // names to lowercase (ADR-0006).
  const subtreeSet = new Set(
    (
      await db.$queryRaw<{ id: string }[]>`
        WITH RECURSIVE subtree AS (
          SELECT n.id
          FROM "Node" n
          WHERE n.id = ${node.id}
            AND n."projectId" = ${node.projectId}
            AND n."deletedAt" IS NULL
          UNION ALL
          SELECT c.id
          FROM "Node" c
          JOIN subtree s ON c."parentId" = s.id
          WHERE c."projectId" = ${node.projectId}
            AND c."deletedAt" IS NULL
        )
        SELECT id FROM subtree`
    ).map((r) => r.id),
  );

  // (1) CYCLE: the new parent in the moving subtree (including
  // `parentId === node.id` at depth 0) would create a cycle. ValidationError
  // because the request is malformed for THIS node — no state change makes
  // it valid. Contrast step 2's ConflictError, which says "valid request,
  // change the state and retry".
  if (parentId !== null && subtreeSet.has(parentId)) {
    throw new ValidationError(
      "A Component cannot be moved under itself or one of its descendants.",
    );
  }

  // (2) ORPHANING incident Connections: every active Edge with the moving
  // node as an endpoint lives on the old Canvas (same-Canvas invariant held
  // before the move; ADR-0005). Reject so the agent disconnects first;
  // `conflictingEdgeIds` is the AI-readable channel.
  const incidentEdges = await db.edge.findMany({
    where: {
      projectId: node.projectId,
      deletedAt: null,
      OR: [{ sourceId: node.id }, { targetId: node.id }],
    },
    select: { id: true },
  });
  if (incidentEdges.length > 0) {
    const count = incidentEdges.length;
    throw new ConflictError(
      `Can't move this Component: ${count} active Connection${count === 1 ? "" : "s"} still attach${count === 1 ? "es" : ""} it to its current Canvas. Disconnect the Connection${count === 1 ? "" : "s"} first, then move.`,
      { conflictingEdgeIds: incidentEdges.map((e) => e.id) },
    );
  }

  // Subtree travels by identity — only the moved Node's `parentId` changes;
  // descendants keep their `parentId`, interior Edges keep their
  // `canvasNodeId`. Ordinary Edges respect same-Canvas (ADR-0005), so no
  // descendant Edge crosses the subtree boundary. Cross-scope FlowRoutes are
  // self-consistent under move (see the docstring): `routeFlow` already
  // pins the boundary endpoint to a sibling of the inner-Edge scope, so
  // whenever the inner scope rides into the subtree, the boundary endpoint
  // does too.
  return db.node.update({
    where: { id: node.id },
    data: { parentId },
  });
}

/**
 * Commits a batch of Component positions in one call — the single mutation the
 * Canvas fires on drag-stop (the perf model commits exactly one write when a
 * drag ends, never one per frame; CONTEXT.md / PRD). Batch by design because a
 * React Flow multi-select drag moves N Components at once.
 *
 * Owner-only: authorized ONCE against the Project (resolved by `projectId`, an
 * internal handle — writes are never slug-granted, ADR-0002). Before any write,
 * every position's `id` is confirmed to belong to that owned Project, so a Node
 * id from another project can neither be moved nor leave a partial write behind;
 * a shortfall surfaces as not-found (the web client rolls back its optimistic
 * update; a future MCP caller gets a readable error) rather than a silent
 * partial success. Ownership comes from the actor, never from `input` (ADR-0001).
 */
export async function updatePositions(
  db: Db,
  actor: Actor,
  input: UpdatePositionsInput,
): Promise<Node[]> {
  const { projectId, positions } = updatePositionsInput.parse(input);

  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  // Confirm the whole id set belongs to this (owned, non-deleted) Project before
  // touching anything — `new Set` so a duplicated id is counted once. A shortfall
  // means an id was foreign or soft-deleted: reject the entire batch rather than
  // write the valid subset and report failure.
  const ids = positions.map((p) => p.id);
  const owned = await db.node.findMany({
    where: { projectId: project.id, id: { in: ids }, deletedAt: null },
    select: { id: true },
  });
  if (owned.length !== new Set(ids).size) {
    throw new NotFoundError();
  }

  // Each `update` returns its row, so the batch result is the updated Nodes.
  return Promise.all(
    positions.map((p) =>
      db.node.update({
        where: { id: p.id },
        data: { posX: p.posX, posY: p.posY },
      }),
    ),
  );
}

/**
 * Fail-loud backstop for the cascade (ADR-0008). After `deleteNode` stamps a
 * subtree, NO live Node may remain directly under any stamped node — that is the
 * invariant the `deletedAt IS NULL` recursive descent rests on ("no live Node
 * ever sits under a soft-deleted ancestor"). Because the sequential cascade
 * always gathers every live descendant, the only way such an orphan appears is a
 * concurrent `createNode` that committed a child under a soon-to-be-deleted
 * parent between the subtree read and the commit — the accepted READ COMMITTED
 * window ADR-0008 documents. Throwing `ConflictError` (→ TRPC `CONFLICT`) rolls
 * the whole transaction back, so the would-be orphan is never persisted and the
 * caller can retry; the web client's `removeComponent` catch rolls back its
 * optimistic update and toasts. Exported so the guard's reject path is unit
 * testable against a deliberately-constructed orphan state.
 */
export async function assertNoOrphanedChildren(
  db: Db,
  parentIds: string[],
): Promise<void> {
  const orphan = await db.node.findFirst({
    where: { parentId: { in: parentIds }, deletedAt: null },
    select: { id: true },
  });
  if (orphan) {
    throw new ConflictError(
      "The component changed during deletion. Please try again.",
    );
  }
}

/**
 * Deletes a Component via a cascading soft-delete: the target Node, its entire
 * subtree (every Node descending through `parentId`), every incident or
 * interior Connection, AND every owned Flow + owned FlowSpec on any Node in
 * the subtree are flagged `deletedAt` in ONE atomic operation, all stamped
 * with one fresh `deletionId` so the whole set can be undone as a unit
 * (`restoreNode`; ADR-0008 + ADR-0011). The safety net that matters because
 * AI agents mutate the graph (CONTEXT.md "Soft-delete + undo").
 *
 * Addressed by the Node `id`; loaded, its Project resolved, and authorized
 * owner-only through `access.assertCanWrite` BEFORE the subtree is gathered
 * (ADR-0001) — an intruder learns nothing about the graph's shape. Idempotent in
 * spirit: an already-deleted Component reads as not-found (like `deleteEdge`).
 *
 * The subtree is gathered in a SINGLE recursive CTE descending `parentId` — the
 * mirror of `getCanvas`'s ascending breadcrumb walk — never a per-level loop
 * (ADR-0006, whose raw-SQL discipline this reuses: double-quoted PascalCase
 * identifiers, bound params, a `depth < 256` cap, `deletedAt IS NULL` on both
 * arms). Filtering `deletedAt IS NULL` on the recursive step is safe because no
 * live Node ever sits under a soft-deleted ancestor (a cascade sweeps the whole
 * subtree, and `createNode` rejects a soft-deleted parent), so the walk never
 * needs to pass THROUGH a deleted Node to reach a live descendant.
 *
 * The Edge sweep is `sourceId ∈ S OR targetId ∈ S OR canvasNodeId ∈ S` (S = the
 * subtree), NEVER `canvasNodeId` alone: an "incident" Connection from the deleted
 * Component up to a SURVIVING sibling lives on the parent's Canvas
 * (`canvasNodeId ∉ S`) yet must still be swept, or it would dangle to a deleted
 * endpoint forever. ADR-0005 made all three Edge columns first-class precisely so
 * this cannot be reduced to scope. The Flow / FlowSpec sweeps are simpler — both
 * have only one FK into Node (`ownerNodeId`), so the union widens to Edge only.
 * All `updateMany`s filter `deletedAt: null`, so a Connection / Flow / FlowSpec
 * the user had already removed via its own lone delete is NOT re-stamped — and
 * so `restoreNode` never revives it.
 *
 * Runs inside the caller's transaction (the router wraps it in
 * `db.$transaction`, like `updatePositions`), so the recursive read and every
 * sweep commit atomically.
 */
export async function deleteNode(
  db: Db,
  actor: Actor,
  input: DeleteNodeInput,
): Promise<{
  deletionId: string;
  nodeIds: string[];
  edgeIds: string[];
  flowIds: string[];
  flowSpecIds: string[];
  flowRouteIds: string[];
}> {
  const { id } = deleteNodeInput.parse(input);

  const node = await db.node.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, projectId: true },
  });
  if (!node) {
    throw new NotFoundError();
  }
  const project = await db.project.findFirst({
    where: { id: node.projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  // Gather the subtree (root included) in one recursive descent of `parentId`.
  // No depth cap — the graph is acyclic (`moveNode` rejects any reparent whose
  // new parent sits in the moving subtree; ADR-0024), so the recursion
  // terminates naturally. Completeness beats a cap: a truncated cascade would
  // silently orphan a descendant under a deleted ancestor, violating ADR-0008.
  // If cycle prevention ever regresses, the fail-loud guard below catches any
  // orphan that slips through. Bound params only; identifiers double-quoted
  // PascalCase because Postgres folds unquoted names to lowercase (ADR-0006).
  const subtree = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE subtree AS (
      SELECT n.id
      FROM "Node" n
      WHERE n.id = ${node.id}
        AND n."projectId" = ${node.projectId}
        AND n."deletedAt" IS NULL
      UNION ALL
      SELECT c.id
      FROM "Node" c
      JOIN subtree s ON c."parentId" = s.id
      WHERE c."projectId" = ${node.projectId}
        AND c."deletedAt" IS NULL
    )
    SELECT id FROM subtree`;
  const nodeIds = subtree.map((row) => row.id);

  const deletionId = randomUUID();
  const deletedAt = new Date();

  // The Edge sweep: any live Edge with an endpoint in the subtree OR drawn on a
  // deleted Component's interior Canvas. Capture the ids first (for the
  // optimistic-UI return), then stamp the same live set.
  const edgeWhere = {
    projectId: node.projectId,
    deletedAt: null,
    OR: [
      { sourceId: { in: nodeIds } },
      { targetId: { in: nodeIds } },
      { canvasNodeId: { in: nodeIds } },
    ],
  };
  const sweptEdges = await db.edge.findMany({
    where: edgeWhere,
    select: { id: true },
  });
  const edgeIds = sweptEdges.map((edge) => edge.id);

  // Flow / FlowSpec sweep (ADR-0011): owned by any Node in the subtree. Only
  // one FK column to union over (`ownerNodeId`), unlike Edge's three. The
  // `deletedAt: null` filter is load-bearing — a Flow already removed by a
  // lone `deleteFlow` (which mints no `deletionId`) must NOT be re-stamped,
  // or `restoreNode` would wrongly revive it as part of this batch.
  const flowWhere = {
    projectId: node.projectId,
    ownerNodeId: { in: nodeIds },
    deletedAt: null,
  };
  const flowSpecWhere = {
    projectId: node.projectId,
    ownerNodeId: { in: nodeIds },
    deletedAt: null,
  };
  const sweptFlows = await db.flow.findMany({
    where: flowWhere,
    select: { id: true },
  });
  const flowIds = sweptFlows.map((f) => f.id);
  const sweptFlowSpecs = await db.flowSpec.findMany({
    where: flowSpecWhere,
    select: { id: true },
  });
  const flowSpecIds = sweptFlowSpecs.map((s) => s.id);

  // FlowRoute sweep (Slice 2): any active route whose outerEdge or
  // innerEdge sits in the swept Edge set, OR whose Flow sits in the swept
  // Flow set. The innerEdgeId arm is forward-compat for Slice 3 — Slice 2
  // never writes it but the sweep must include it so Slice 3 needs no
  // retrofit. The flowId arm picks up routes whose owner-Node deletion
  // takes the Flow itself, even if the route's outerEdge sits outside the
  // subtree (an inbound API call from a surviving sibling, e.g.).
  const flowRouteWhere = {
    projectId: node.projectId,
    deletedAt: null,
    OR: [
      { outerEdgeId: { in: edgeIds } },
      { innerEdgeId: { in: edgeIds } },
      { flowId: { in: flowIds } },
    ],
  };
  const sweptRoutes =
    edgeIds.length === 0 && flowIds.length === 0
      ? []
      : await db.flowRoute.findMany({
          where: flowRouteWhere,
          select: { id: true },
        });
  const flowRouteIds = sweptRoutes.map((r) => r.id);

  await db.node.updateMany({
    where: { id: { in: nodeIds }, deletedAt: null },
    data: { deletedAt, deletionId },
  });
  await db.edge.updateMany({
    where: edgeWhere,
    data: { deletedAt, deletionId },
  });
  await db.flow.updateMany({
    where: flowWhere,
    data: { deletedAt, deletionId },
  });
  await db.flowSpec.updateMany({
    where: flowSpecWhere,
    data: { deletedAt, deletionId },
  });
  if (flowRouteIds.length > 0) {
    await db.flowRoute.updateMany({
      where: flowRouteWhere,
      data: { deletedAt, deletionId },
    });
  }

  // Post-stamp guard (ADR-0008): the sequential cascade always gathers every live
  // descendant, so a live child still sitting directly under the freshly-stamped
  // set means a concurrent createNode raced us between the subtree read and this
  // commit. Fail loud rather than leave a silent, unrecoverable orphan.
  await assertNoOrphanedChildren(db, nodeIds);

  return { deletionId, nodeIds, edgeIds, flowIds, flowSpecIds, flowRouteIds };
}

/**
 * Undoes a cascading Component delete: restores EXACTLY the rows stamped with the
 * given `deletionId` and nothing else (ADR-0008) — `deletedAt` and `deletionId`
 * are both cleared, so the batch handle is consumed. Because the cascade only
 * ever stamped rows it itself transitioned to deleted (its `updateMany`s filter
 * `deletedAt: null`), a Connection or descendant removed by some OTHER operation
 * never carries this id and is never revived here; two independent deletes undo
 * independently.
 *
 * Undo is a WRITE — owner-only. The Project is resolved from the stamped rows
 * (never from input), then authorized through `access.assertCanWrite`
 * (ADR-0001/0002); a capability-URL viewer cannot undo. An unknown or
 * already-restored `deletionId` matches no rows and reads as not-found.
 *
 * Restore is "as-is": if an ancestor of this batch was independently deleted in
 * a LATER operation, the restored subtree is briefly unreachable via `getCanvas`
 * until that ancestor is also restored — honoring "restore exactly the affected
 * set and nothing outside it" literally. Runs inside the caller's transaction.
 */
export async function restoreNode(
  db: Db,
  actor: Actor,
  input: RestoreNodeInput,
): Promise<{
  deletionId: string;
  nodeIds: string[];
  edgeIds: string[];
  flowIds: string[];
  flowSpecIds: string[];
  flowRouteIds: string[];
}> {
  const { deletionId } = restoreNodeInput.parse(input);

  const nodes = await db.node.findMany({
    where: { deletionId },
    select: { id: true, projectId: true },
  });
  // A deletion never spans Projects (the cascade is scoped to one), so any
  // stamped row resolves the owner. No rows = unknown / already-restored handle.
  const [firstNode] = nodes;
  if (!firstNode) {
    throw new NotFoundError();
  }
  const project = await db.project.findFirst({
    where: { id: firstNode.projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  const edges = await db.edge.findMany({
    where: { deletionId },
    select: { id: true, canvasNodeId: true, sourceId: true, targetId: true },
  });
  const stampedFlows = await db.flow.findMany({
    where: { deletionId },
    select: { id: true, ownerNodeId: true, key: true },
  });
  const stampedFlowSpecs = await db.flowSpec.findMany({
    where: { deletionId },
    select: { id: true, ownerNodeId: true },
  });
  const stampedRoutes = await db.flowRoute.findMany({
    where: { deletionId },
    select: { id: true, outerEdgeId: true, flowId: true },
  });

  // Pre-check the `idx_edge_dedup` invariant (ADR-0010): any active row whose
  // triple matches one we're about to revive would block the updateMany. Done
  // BEFORE the updates because Postgres aborts the transaction on P2002 and
  // we couldn't query for diagnostics from inside the catch.
  //
  // Reachable today only via direct DB manipulation — cascading-delete sweeps
  // an edge alongside at least one of its endpoints, so re-drawing the same
  // triple while soft-deleted always involves a fresh-id endpoint. The path
  // becomes reachable in production when slice 3 of the flow-routed plan
  // lands (`routeFlow` introduces cross-scope inner edges whose triples are
  // independent of the cascading sweep); the regression test lands with #36.
  if (edges.length > 0) {
    const conflicts = await db.edge.findMany({
      where: {
        deletedAt: null,
        OR: edges.map(({ canvasNodeId, sourceId, targetId }) => ({
          canvasNodeId,
          sourceId,
          targetId,
        })),
      },
      select: { id: true },
    });
    if (conflicts.length > 0) {
      const count = conflicts.length;
      throw new ConflictError(
        `Can't undo this delete: ${count} Connection${count === 1 ? "" : "s"} cannot be restored because a new Connection now occupies the same source/target slot. Delete the conflicting Connection${count === 1 ? "" : "s"} and retry.`,
        { conflictingEdgeIds: conflicts.map((e) => e.id) },
      );
    }
  }

  // Pre-check the `idx_flow_dedup` invariant (ADR-0010 + ADR-0011): a stamped
  // Flow's (ownerNodeId, key) slot may now be occupied by a hand-authored
  // Flow created since the delete. Same posture as the Edge pre-check above;
  // surfaces a readable ConflictError with the conflicting Flow id(s) so the
  // user can resolve and retry.
  if (stampedFlows.length > 0) {
    const conflicts = await db.flow.findMany({
      where: {
        deletedAt: null,
        OR: stampedFlows.map(({ ownerNodeId, key }) => ({ ownerNodeId, key })),
      },
      select: { id: true },
    });
    if (conflicts.length > 0) {
      const count = conflicts.length;
      throw new ConflictError(
        `Can't undo this delete: ${count} Flow${count === 1 ? "" : "s"} cannot be restored because a new Flow now occupies the same owner/key slot. Delete the conflicting Flow${count === 1 ? "" : "s"} and retry.`,
        { conflictingFlowIds: conflicts.map((f) => f.id) },
      );
    }
  }

  // FlowSpec is 1:1 with its owner Node (`ownerNodeId @unique`); restoring a
  // stamped FlowSpec collides if the user attached a fresh FlowSpec to the
  // same Node since the delete. Same readable-error posture as the Flow case.
  if (stampedFlowSpecs.length > 0) {
    const conflicts = await db.flowSpec.findMany({
      where: {
        deletedAt: null,
        ownerNodeId: { in: stampedFlowSpecs.map((s) => s.ownerNodeId) },
      },
      select: { id: true },
    });
    if (conflicts.length > 0) {
      const count = conflicts.length;
      throw new ConflictError(
        `Can't undo this delete: ${count} FlowSpec${count === 1 ? "" : "s"} cannot be restored because a new FlowSpec now occupies the same Component. Delete the conflicting FlowSpec${count === 1 ? "" : "s"} and retry.`,
        { conflictingFlowSpecIds: conflicts.map((s) => s.id) },
      );
    }
  }

  // Pre-check the `idx_flow_route_dedup` invariant (ADR-0010 + Slice 2): a
  // stamped FlowRoute's (outerEdgeId, flowId) slot may now be occupied by a
  // fresh route. Same readable-error posture as the Edge / Flow / FlowSpec
  // pre-checks above.
  if (stampedRoutes.length > 0) {
    const conflicts = await db.flowRoute.findMany({
      where: {
        deletedAt: null,
        OR: stampedRoutes.map(({ outerEdgeId, flowId }) => ({
          outerEdgeId,
          flowId,
        })),
      },
      select: { id: true },
    });
    if (conflicts.length > 0) {
      const count = conflicts.length;
      throw new ConflictError(
        `Can't undo this delete: ${count} routed Flow${count === 1 ? "" : "s"} cannot be restored because a new route now occupies the same Connection/Flow slot. Remove the conflicting route${count === 1 ? "" : "s"} and retry.`,
        { conflictingFlowRouteIds: conflicts.map((r) => r.id) },
      );
    }
  }

  await db.node.updateMany({
    where: { deletionId },
    data: { deletedAt: null, deletionId: null },
  });

  try {
    await db.edge.updateMany({
      where: { deletionId },
      data: { deletedAt: null, deletionId: null },
    });
  } catch (error) {
    if (!isEdgeDedupCollision(error)) throw error;
    // Race fallback: the pre-check passed but a concurrent writer slipped a
    // conflicting active Edge in between. The transaction is now aborted, so
    // we cannot query for diagnostics here. Throw plain; the caller's retry
    // will hit the pre-check path and get the rich error.
    throw new ConflictError(
      "Undo blocked by a concurrent write — retry to see what conflicts.",
      { conflictingEdgeIds: [] },
    );
  }

  try {
    await db.flow.updateMany({
      where: { deletionId },
      data: { deletedAt: null, deletionId: null },
    });
  } catch (error) {
    if (!isFlowDedupCollision(error)) throw error;
    throw new ConflictError(
      "Undo blocked by a concurrent write — retry to see what conflicts.",
      { conflictingFlowIds: [] },
    );
  }

  await db.flowSpec.updateMany({
    where: { deletionId },
    data: { deletedAt: null, deletionId: null },
  });

  try {
    await db.flowRoute.updateMany({
      where: { deletionId },
      data: { deletedAt: null, deletionId: null },
    });
  } catch (error) {
    if (!isFlowRouteDedupCollision(error)) throw error;
    throw new ConflictError(
      "Undo blocked by a concurrent write — retry to see what conflicts.",
      { conflictingFlowRouteIds: [] },
    );
  }

  return {
    deletionId,
    nodeIds: nodes.map((n) => n.id),
    edgeIds: edges.map((e) => e.id),
    flowIds: stampedFlows.map((f) => f.id),
    flowSpecIds: stampedFlowSpecs.map((s) => s.id),
    flowRouteIds: stampedRoutes.map((r) => r.id),
  };
}
