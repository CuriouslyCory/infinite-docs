import { randomUUID } from "node:crypto";

import {
  type Node,
  type NodeKind as PrismaNodeKind,
  type Prisma,
} from "../../../generated/prisma/client";
import { capabilityAtLeast } from "./access";
import {
  authorizeProjectWrite,
  resolveReadableProject,
  resolveReadableProjectById,
} from "./access-db";
import { activeDuplicateWhere } from "./edge.service";
import type { Actor, Db } from "./actor";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { isEdgeDedupCollision, isPrismaUniqueViolation } from "./prisma-errors";
import {
  createEmbeddedComponentInput,
  createNodeInput,
  deleteNodeInput,
  getCanvasInput,
  listProjectComponentsInput,
  moveNodeInput,
  restoreNodeInput,
  updateNodeDocumentationInput,
  updateNodeInput,
  updateNodeKindInput,
  updatePositionsInput,
  upsertBoundaryProxyPlacementInput,
  type CreateEmbeddedComponentInput,
  type CreateNodeInput,
  type DeleteNodeInput,
  type GetCanvasInput,
  type Interaction,
  type ListProjectComponentsInput,
  type MoveNodeInput,
  type NodeKind,
  type RestoreNodeInput,
  type UpdateNodeDocumentationInput,
  type UpdateNodeInput,
  type UpdateNodeKindInput,
  type UpdatePositionsInput,
  type UpsertBoundaryProxyPlacementInput,
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

// The neutral title a `locked` Project Portal carries on the wire (#120). A
// portal's stored `title` is the FOREIGN project's title, captured at embed time;
// once the descending actor loses read access to the target, surfacing that title
// would disclose foreign identity. So a locked portal's title is REPLACED with
// this non-identifying sentinel server-side (the foreign `embeddedProjectId` is
// already redacted from every interior node) — the host node is acknowledged, its
// foreign identity withheld (ADR-0041 non-disclosure).
const LOCKED_PORTAL_TITLE = "Locked project";

/**
 * Creates a Component (a Node) on a Canvas scope within a Project. The scope is
 * `parentId`: null is the Project's root Canvas, otherwise the id of the
 * containing Component — which, when non-null, must be a live Node in this same
 * Project (a child Component cannot hang off a missing, soft-deleted, or
 * foreign-Project parent). `kind` is cosmetic (icon/color only — CONTEXT.md
 * "Component kind"); `posX`/`posY` are the drop point.
 *
 * Requires `edit` capability — owner, ADMIN, or EDITOR member (ADR-0040). The
 * Project is addressed by `projectId` (an internal handle, never the capability
 * slug — writes are never slug-granted, ADR-0002) and the write is authorized
 * through `access-db.authorizeProjectWrite(…, "edit")`. The actor identity comes
 * from the session, never from `input` (ADR-0001).
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
  const {
    projectId,
    parentId,
    kind,
    title,
    posX,
    posY,
    documentation,
    metadata,
    sourceSpecId,
    specKey,
  } = createNodeInput.parse(input);

  const project = await authorizeProjectWrite(db, actor, projectId, "edit");

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
      select: { id: true, embeddedProjectId: true },
    });
    if (!parent) {
      throw new NotFoundError();
    }
    // A portal Component has no host interior — its interior IS the foreign
    // root, so a host child can never hang off it (#121, ADR-0042). Rejected by
    // the FK discriminator, not by kind. Distinct from not-found: the parent
    // exists in scope but cannot legally hold interior children.
    if (parent.embeddedProjectId !== null) {
      throw new ValidationError(
        "A portal Component has no interior; embed children belong to the embedded project.",
      );
    }
  }

  // A non-null `sourceSpecId` must reference a live Spec in this same owned
  // Project — the same set-membership posture as the parentId check above, so a
  // foreign Spec id can never be linked (cross-project provenance smuggling) and
  // its existence elsewhere is never disclosed. The applier always creates the
  // Spec first, so the FK resolves on the happy path.
  if (sourceSpecId !== undefined) {
    const spec = await db.spec.findFirst({
      where: { id: sourceSpecId, projectId: project.id, deletedAt: null },
      select: { id: true },
    });
    if (!spec) {
      throw new NotFoundError();
    }
  }

  // The optional provenance fields ride the same create (#64 / ADR-0029).
  // `metadata` is UNTRUSTED JSON, stored verbatim. Undefined fields are omitted
  // so the plain canvas create path is unchanged (blank docs, null
  // metadata/provenance).
  const data: Prisma.NodeUncheckedCreateInput = {
    projectId: project.id,
    parentId,
    kind,
    title,
    posX,
    posY,
  };
  if (documentation !== undefined) data.documentation = documentation;
  if (metadata !== undefined) data.metadata = metadata;
  if (sourceSpecId !== undefined) data.sourceSpecId = sourceSpecId;
  if (specKey !== undefined) data.specKey = specKey;

  return db.node.create({ data });
}

/**
 * Creates a Project Portal — a Component carrying `embeddedProjectId`, a live
 * pointer into another Project (#119). The dual-project gate runs in a DELIBERATE
 * ORDER, and the order IS the non-disclosure property:
 *
 *   1. HOST `edit` FIRST (`authorizeProjectWrite(projectId, "edit")` → Forbidden on
 *      deny). The host id is a handle the caller already holds, so a Forbidden here
 *      leaks nothing — and gating it first means a caller who cannot edit the host
 *      never even probes the target, so this path can NEVER be used to oracle a
 *      foreign project's existence/read-shape.
 *   2. SELF-EMBED reject (`embeddedProjectId === projectId` → ValidationError): a
 *      Project embedding itself is a degenerate infinite portal; reject it before
 *      the target read so the message is precise.
 *   3. TARGET ≥ `view` (`resolveReadableProjectById(embeddedProjectId)` → NotFound
 *      on deny). "You may only embed what you can read." A target the actor cannot
 *      read is indistinguishable from a missing one (non-disclosure), so an editor
 *      of the host cannot enumerate foreign projects by trying to embed ids.
 *
 * `kind` is cosmetic (a portal's behavior comes from the FK, not the kind —
 * ADR-0018). `parentId`, when non-null, must be a live Node in the HOST project
 * (the same set-membership posture `createNode` uses). Identity comes from the
 * actor, never `input` (ADR-0001); `title` is UNTRUSTED, stored verbatim.
 */
export async function createEmbeddedComponent(
  db: Db,
  actor: Actor,
  input: CreateEmbeddedComponentInput,
): Promise<Node> {
  const { projectId, embeddedProjectId, parentId, kind, title, posX, posY } =
    createEmbeddedComponentInput.parse(input);

  // (1) Host edit gate FIRST — Forbidden on deny (the handle is already held).
  const project = await authorizeProjectWrite(db, actor, projectId, "edit");

  // (2) Reject self-embed before touching the target.
  if (embeddedProjectId === project.id) {
    throw new ValidationError("A Project cannot embed itself.");
  }

  // (3) Target read gate — NotFound on deny (non-disclosure; "embed what you read").
  await resolveReadableProjectById(db, actor, embeddedProjectId);

  // A non-null parent must be a live Node in the HOST project — a portal lives on
  // the host's Canvas, so its scope is a host Node, never a foreign one.
  if (parentId !== null) {
    const parent = await db.node.findFirst({
      where: { id: parentId, projectId: project.id, deletedAt: null },
      select: { id: true, embeddedProjectId: true },
    });
    if (!parent) {
      throw new NotFoundError();
    }
    if (parent.embeddedProjectId !== null) {
      throw new ValidationError(
        "A portal Component has no interior; embed children belong to the embedded project.",
      );
    }
  }

  return db.node.create({
    data: {
      projectId: project.id,
      parentId,
      kind,
      title,
      posX,
      posY,
      embeddedProjectId,
    },
  });
}

// Bound on the breadcrumb ancestry walk. The graph is acyclic — `moveNode`
// owns cycle prevention (ADR-0024,
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

/**
 * A single Connection as the Canvas read returns it: the stored Edge fields plus
 * the two derived `*Repr` ids that resolve each endpoint onto THIS scope. For a
 * same-Canvas Connection `sourceRepr === sourceId` and `targetRepr === targetId`;
 * for the altitude view both reprs are ancestor Nodes of the real endpoints; for
 * a cross-scope Connection the off-scope end's repr is the synthetic id of its
 * boundary proxy (see {@link CanvasBoundaryProxy}). The reprs are a per-scope
 * read-time projection, never stored on the Edge (ADR-0031).
 */
export interface CanvasInteriorEdge {
  id: string;
  sourceId: string;
  targetId: string;
  sourceRepr: string;
  targetRepr: string;
  interaction: Interaction;
  label: string | null;
}

/**
 * A read-only stand-in for the off-scope endpoint of a Connection that crosses
 * this scope (CONTEXT.md "Boundary proxy"; ADR-0031). One row PER crossing edge —
 * a Component reached as the far endpoint of three crossing Connections yields
 * three proxies that share `realEndpointId` but each carry a distinct synthetic
 * `nodeId` (`proxy_<edgeId>`), so React Flow keys never collide and a proxy stays
 * addressable by the edge that produced it.
 *
 * The first five fields are DERIVED from endpoint ancestry and persist no row of
 * their own (ADR-0031 frozen identity). `posX`/`posY` are an ADDITIVE, nullable
 * adjunct — the persisted VIEW coordinate from `BoundaryProxyPlacement` for this
 * scope's proxy of `realEndpointId` (#91 / ADR-0036), `null` when the proxy has
 * never been dragged on this scope (the client falls back to the left rail). They
 * carry the COALESCED placement: every per-edge row sharing a `realEndpointId`
 * gets the same coordinate, keyed by the endpoint, never by `proxy_<edgeId>`.
 * The client renders the proxy as a passive node (#65).
 */
export interface CanvasBoundaryProxy {
  nodeId: string;
  title: string;
  kind: NodeKind;
  realEndpointId: string;
  edgeId: string;
  posX: number | null;
  posY: number | null;
}

// One row per active Connection whose endpoint ancestry makes it relevant to the
// scope, as the cross-scope derivation CTE emits it — before the service splits
// it into an interior edge ± a boundary proxy. `source_rep` / `target_rep` are
// the on-scope representative Node ids (null when that endpoint is off-scope);
// `truncated` flags an ancestry walk clipped by `ANCESTRY_DEPTH_CAP`. The
// `*_title` / `*_kind` columns carry the real far endpoint's display fields so a
// proxy can be built without a second query.
interface CrossScopeEdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  interaction: Interaction;
  label: string | null;
  source_title: string;
  source_kind: NodeKind;
  source_embedded_project_id: string | null;
  target_title: string;
  target_kind: NodeKind;
  target_embedded_project_id: string | null;
  source_rep: string | null;
  target_rep: string | null;
  truncated: boolean;
}

/**
 * Materializes a Canvas for a scope in a single round trip (ADR-0001): its
 * interior Components, the Connections relevant to the scope (each endpoint
 * resolved to a real Node or a boundary proxy), the boundary proxies those
 * cross-scope Connections need, and the breadcrumb trail. Addressed by the
 * capability `slug` (the read grant, ADR-0002), so it works without a session.
 *
 * `interiorNodes` are the Nodes whose `parentId` is the scope.
 *
 * `interiorEdges` and `boundaryProxies` are DERIVED from endpoint ancestry, never
 * a stored Edge scope (an Edge dropped `canvasNodeId` in #62, ADR-0028). For
 * scope `S` and Edge `E=(A,B)`, let `rep(N,S)` be the ancestor of `N` whose
 * parent is `S` (so `rep(N,S) === N` when `N.parentId === S`; absent when `S` is
 * not on `N`'s ancestor chain). With `a = rep(A,S)`, `b = rep(B,S)` (ADR-0031):
 *   - both present, `a≠b` → an `interiorEdges` row between real Nodes `a`,`b`
 *     (same-Canvas when the reprs equal the endpoints; the altitude view when
 *     they are ancestors).
 *   - exactly one present → an `interiorEdges` row from the on-scope real Node to
 *     a `boundaryProxies` stand-in for the off-scope endpoint (lineal/ingress
 *     included: a parent→child Connection on the parent's interior Canvas is
 *     real-child ↔ proxy-of-parent).
 *   - both present and `a==b`, or neither present → not rendered on `S`.
 * The whole derivation is ONE recursive CTE — the ancestry walk runs for both
 * endpoints of every active Edge in the Project at once, never a per-edge or
 * per-level query (ADR-0006) — joined into the concurrent `Promise.all`, so the
 * read stays a single round trip.
 *
 * `breadcrumbs` is the ordered ancestor chain (root → current scope, included)
 * computed in a SINGLE recursive CTE, never a per-level walk (ADR-0006). The
 * root scope (`canvasNodeId === null`) has no ancestors and returns `[]`. A
 * non-null scope that resolves to no live Node in this Project (missing /
 * soft-deleted / cross-project) is a not-found — detected by an empty breadcrumb
 * trail, NOT by an empty interior (an empty interior is a legitimate leaf
 * Component).
 *
 * Loud truncation, never silent (ADR-0006, ADR-0031): a breadcrumb walk OR a
 * connection-ancestry walk that reaches `ANCESTRY_DEPTH_CAP` throws a typed error
 * rather than returning a quietly-incomplete Canvas. The two carry DISTINCT
 * messages so the cause is unambiguous.
 *
 * NOTE: both derived reads are raw SQL. Postgres folds unquoted identifiers to
 * lowercase, so every model/column name is double-quoted PascalCase; the scope
 * id and project id are bound parameters, never string-interpolated (ADR-0006).
 *
 * Capability-gated read (ADR-0040, generalizing ADR-0002): the slug→project bind
 * below resolves the caller's capability and requires `view`. For the default
 * `guestAccess=VIEW` this is exactly the old slug-grant (anonymous read+descend);
 * a `guestAccess=NONE` project resolves to not-found for a non-member. `actor` is
 * now consulted (for the owner check and the membership lookup), though anonymous
 * callers still skip the membership query.
 *
 * Project Portals (#119): `embedPath` is the ordered stack of portal Node ids
 * crossed to reach this scope. After the host slug gate, the walk re-resolves the
 * DESCENDING ACTOR's capability against each crossing's embedded Project (never the
 * host's capability — the host's grant must not govern foreign content), so the
 * URL stays on the host while the ACTIVE project advances inward. Every crossing is
 * re-gated because `embedPath` is untrusted client state: a forged or stale id, a
 * non-portal node, a foreign node, or an embedded project the actor cannot read all
 * collapse to NotFound (non-disclosure — the headline security property). All the
 * interior/edge/breadcrumb/placement reads below run against the resolved ACTIVE
 * project.id (they are already project-id-parameterized), and `embedTrail` carries
 * the crossed portals so the client stitches the host→portal→foreign spine. Each
 * interior portal Node is annotated `isPortal: true` + a per-actor `embedAccess`
 * tier (#120) — `enterable` (≥ edit), `readOnly` (= view), or `locked` (no grant) —
 * so the client renders the right affordance without leaking the target's existence;
 * the foreign `embeddedProjectId` is stripped from every interior node, and a
 * `locked` portal's title is replaced with a neutral sentinel (non-disclosure
 * firewall: neither id nor foreign title reaches the wire).
 */
export async function getCanvas(
  db: Db,
  actor: Actor | null,
  input: GetCanvasInput,
): Promise<{
  interiorNodes: (Omit<Node, "embeddedProjectId"> & {
    isPortal: boolean;
    embedAccess?: "enterable" | "readOnly" | "locked";
  })[];
  interiorEdges: CanvasInteriorEdge[];
  boundaryProxies: CanvasBoundaryProxy[];
  breadcrumbs: { id: string; title: string; kind: NodeKind }[];
  embedTrail: { id: string; title: string; kind: NodeKind }[];
  activeProject: { id: string; title: string; canEdit: boolean };
}> {
  const { slug, canvasNodeId, embedPath } = getCanvasInput.parse(input);

  // Gate ONCE at the slug→project bind, capability >= `view` (ADR-0040).
  // Authorization is project-scoped, so this single gate covers every descent
  // scope, every breadcrumb ancestor, and every boundary proxy below — all
  // interior to the ACTIVE project (resolved by the portal walk below) — with no
  // per-node authz. A non-member of a `guestAccess=NONE` project gets not-found.
  const hostProject = await resolveReadableProject(db, actor, slug);

  // The capability that governs writes against the ACTIVE scope. It starts as
  // the host's and advances to each crossed portal's target capability, so after
  // a portal walk `canEdit` reflects the FOREIGN project's grant — the seam that
  // makes edit-through honest without putting the Capability union on the wire
  // (#121, ADR-0042). Only the derived boolean crosses to the client (ADR-0004).
  let activeCapability = hostProject.viewerCapability;

  // Walk the portal stack IN ORDER (#119). `project` starts as the host and
  // advances to each crossing's embedded Project, re-gated per-actor. The portal
  // Node is loaded scoped to the CURRENT active project (id + projectId), so a
  // foreign or non-existent id never resolves, and a node lacking
  // `embeddedProjectId` is not a portal — both collapse to NotFound. The re-gate
  // (`resolveReadableProjectById`) maps a target the actor cannot read to NotFound
  // too, so a locked portal is indistinguishable from a stale id (non-disclosure).
  let activeProjectId = hostProject.id;
  const embedTrail: { id: string; title: string; kind: NodeKind }[] = [];
  for (const portalNodeId of embedPath) {
    const portal = await db.node.findFirst({
      where: { id: portalNodeId, projectId: activeProjectId, deletedAt: null },
      select: { embeddedProjectId: true, title: true, kind: true },
    });
    if (portal?.embeddedProjectId == null) {
      throw new NotFoundError();
    }
    const resolved = await resolveReadableProjectById(
      db,
      actor,
      portal.embeddedProjectId,
    );
    activeProjectId = resolved.id;
    activeCapability = resolved.viewerCapability;
    embedTrail.push({
      id: portalNodeId,
      title: portal.title,
      kind: portal.kind,
    });
  }

  // The active project the reads below run against. After an empty walk this is
  // the host; after a non-empty walk it is the innermost embedded project. Load
  // its display title for the client's foreign-segment spine; the foreign SLUG is
  // deliberately NOT exposed (the URL stays the host's — ADR-0002 non-disclosure).
  const activeProjectRow = await db.project.findUniqueOrThrow({
    where: { id: activeProjectId },
    select: { id: true, title: true },
  });
  const project = { id: activeProjectId };

  // The four reads run in one `Promise.all` — no waterfall, no dependency on
  // `interiorNodes` resolving first (ADR-0001). The interior Nodes fall out of a
  // flat `parentId` filter; the cross-scope edge derivation and the breadcrumb
  // trail are each ONE recursive CTE over endpoint / scope ancestry; the boundary-
  // proxy placements are a flat read of this scope's persisted view coordinates
  // (#91 / ADR-0036), joined onto the derived proxies below by `realEndpointId`.
  const [interiorNodes, crossScopeRows, breadcrumbs, proxyPlacements] =
    await Promise.all([
      db.node.findMany({
        where: {
          projectId: project.id,
          parentId: canvasNodeId,
          deletedAt: null,
        },
        orderBy: { createdAt: "asc" },
      }),
      // For every active Connection in the Project, walk BOTH endpoints' `parentId`
      // ancestry toward the scope, emitting the on-scope representative of each end
      // (`*_rep`, null when that end is off-scope). `live_edges` keeps only the
      // Connections whose both endpoints are live (a soft-deleted endpoint hides
      // the Connection — the same posture the prior interior-edges relation filter
      // had). The recursive arm climbs only while the current node's parent is
      // still distinct from the scope (so it STOPS at the representative) and under
      // the depth cap; a clip sets `truncated`. The final filter drops the
      // "both reps equal" collapse and the "neither present" case in SQL, leaving
      // exactly the interior + cross-scope rows the service partitions below.
      db.$queryRaw<CrossScopeEdgeRow[]>`
      WITH RECURSIVE live_edges AS (
        SELECT
          e.id                AS edge_id,
          e."sourceId"        AS source_id,
          e."targetId"        AS target_id,
          e.interaction::text AS interaction,
          e.label             AS label,
          e."createdAt"       AS created_at,
          sn.title            AS source_title,
          sn.kind::text       AS source_kind,
          sn."embeddedProjectId" AS source_embedded_project_id,
          sn."parentId"       AS source_parent,
          tn.title            AS target_title,
          tn.kind::text       AS target_kind,
          tn."embeddedProjectId" AS target_embedded_project_id,
          tn."parentId"       AS target_parent
        FROM "Edge" e
        JOIN "Node" sn ON sn.id = e."sourceId" AND sn."deletedAt" IS NULL
        JOIN "Node" tn ON tn.id = e."targetId" AND tn."deletedAt" IS NULL
        WHERE e."projectId" = ${project.id}
          AND e."deletedAt" IS NULL
      ),
      endpoint_walk AS (
        SELECT edge_id, side, cur_id, cur_parent, depth
        FROM (
          SELECT le.edge_id AS edge_id, 'source' AS side,
                 le.source_id AS cur_id, le.source_parent AS cur_parent,
                 0 AS depth
          FROM live_edges le
          UNION ALL
          SELECT le.edge_id, 'target', le.target_id, le.target_parent, 0
          FROM live_edges le
        ) anchors
        UNION ALL
        SELECT w.edge_id, w.side, p.id, p."parentId", w.depth + 1
        FROM endpoint_walk w
        JOIN "Node" p
          ON p.id = w.cur_parent
          AND p."projectId" = ${project.id}
          AND p."deletedAt" IS NULL
        WHERE w.cur_parent IS DISTINCT FROM ${canvasNodeId}::text
          AND w.depth < ${ANCESTRY_DEPTH_CAP}
      ),
      walk_summary AS (
        SELECT
          edge_id,
          side,
          MAX(CASE WHEN cur_parent IS NOT DISTINCT FROM ${canvasNodeId}::text
                   THEN cur_id END) AS rep_id,
          bool_or(
            depth >= ${ANCESTRY_DEPTH_CAP}
            AND cur_parent IS NOT NULL
            AND cur_parent IS DISTINCT FROM ${canvasNodeId}::text
          ) AS truncated
        FROM endpoint_walk
        GROUP BY edge_id, side
      )
      SELECT
        le.edge_id      AS id,
        le.source_id    AS source_id,
        le.target_id    AS target_id,
        le.interaction  AS interaction,
        le.label        AS label,
        le.source_title AS source_title,
        le.source_kind  AS source_kind,
        le.source_embedded_project_id AS source_embedded_project_id,
        le.target_title AS target_title,
        le.target_kind  AS target_kind,
        le.target_embedded_project_id AS target_embedded_project_id,
        ws_s.rep_id     AS source_rep,
        ws_t.rep_id     AS target_rep,
        (COALESCE(ws_s.truncated, false) OR COALESCE(ws_t.truncated, false))
                        AS truncated
      FROM live_edges le
      LEFT JOIN walk_summary ws_s
        ON ws_s.edge_id = le.edge_id AND ws_s.side = 'source'
      LEFT JOIN walk_summary ws_t
        ON ws_t.edge_id = le.edge_id AND ws_t.side = 'target'
      WHERE
        (COALESCE(ws_s.truncated, false) OR COALESCE(ws_t.truncated, false))
        OR (
          (ws_s.rep_id IS NOT NULL OR ws_t.rep_id IS NOT NULL)
          AND (
            ws_s.rep_id IS NULL
            OR ws_t.rep_id IS NULL
            OR ws_s.rep_id <> ws_t.rep_id
          )
        )
      ORDER BY le.created_at ASC, le.edge_id ASC`,
      // The breadcrumb trail walks `parentId` from the scope up to the root in
      // one recursive CTE (ADR-0006). At the root scope there are no ancestors,
      // so skip the query. `ANCESTRY_DEPTH_CAP` is belt-and-suspenders against a
      // cycle-prevention regression (`moveNode` owns prevention, ADR-0024) and a
      // real depth cap; a walk that reaches it is detected below and throws
      // rather than returning a silently-truncated trail.
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
      // This scope's persisted boundary-proxy placements (#91 / ADR-0036). A flat
      // read keyed by the scope's container (`null` at the root scope, matching the
      // `containerNodeId` natural-key column); joined onto the derived proxies below
      // by `realEndpointId`. Stale rows for an endpoint no longer crossing this scope
      // simply find no proxy to attach to and are ignored — harmless, and reclaimed
      // by the FK cascade when either Node is hard-deleted.
      db.boundaryProxyPlacement.findMany({
        where: { containerNodeId: canvasNodeId },
        select: { realEndpointId: true, posX: true, posY: true },
      }),
    ]);

  // Index placements by the off-scope endpoint they pin — the COALESCED key (#90),
  // so every per-edge proxy row sharing a `realEndpointId` reads the same stored
  // coordinate.
  const placementByEndpoint = new Map<string, { posX: number; posY: number }>(
    proxyPlacements.map((p) => [
      p.realEndpointId,
      { posX: p.posX, posY: p.posY },
    ]),
  );

  // A walk that reached the depth ceiling returns a silently-truncated trail.
  // Surface it as a typed error rather than handing back a quietly-incomplete
  // Canvas — see `ANCESTRY_DEPTH_CAP`. The recursive CTE emits depths 0..CAP, so
  // a full walk is CAP + 1 rows; anything beyond means the ceiling clipped it.
  if (breadcrumbs.length > ANCESTRY_DEPTH_CAP) {
    throw new ValidationError("This Canvas is nested too deeply to display.");
  }

  // A non-null scope with no breadcrumbs never resolved to a live Node in
  // this Project. Key off the breadcrumb trail (a live scope always returns
  // its own row at depth 0), never the interior count — an empty interior
  // is a valid leaf Canvas. The root scope is exempt: it has no Component
  // to resolve.
  if (canvasNodeId !== null && breadcrumbs.length === 0) {
    throw new NotFoundError();
  }

  // A connection-ancestry walk clipped at the ceiling leaves a rep silently
  // absent, which would drop a Connection from the Canvas. Surface it loudly,
  // the boundary-proxy analogue of the breadcrumb truncation above (ADR-0031).
  // A DISTINCT message keeps the two causes unambiguous.
  if (crossScopeRows.some((row) => row.truncated)) {
    throw new ValidationError(
      "A Connection reaches a Component nested too deeply to display.",
    );
  }

  // Non-disclosure firewall for the BOUNDARY-PROXY path (#120, ADR-0041): an
  // off-scope endpoint that is itself a PORTAL (`embeddedProjectId != null`) carries
  // the foreign project's title in its stored `*_title`. If the descending actor's
  // grant on that target was revoked (capability `none`) the proxy must render
  // LOCKED without leaking the foreign title — the same guarantee the interior-node
  // path enforces below. We re-gate the actor against each off-scope portal endpoint's
  // `embeddedProjectId` and neutralize the proxy title when locked. The proxy never
  // carries `embeddedProjectId`, so only the TITLE can leak — that is all we redact.
  //
  // Collect the unique off-scope portal endpoints (keyed by the embedded project id,
  // de-duped) and resolve them ALL IN PARALLEL into a Map before the proxy loop, so a
  // Canvas with many cross-scope portal edges stays a single parallel fan-out rather
  // than a per-proxy awaited waterfall (philosophy #1).
  const lockedEmbeddedProjectIds = new Set<string>();
  {
    const candidateEmbeddedIds = new Set<string>();
    for (const row of crossScopeRows) {
      if (
        row.source_rep !== null &&
        row.target_rep === null &&
        row.target_embedded_project_id !== null
      ) {
        candidateEmbeddedIds.add(row.target_embedded_project_id);
      }
      if (
        row.target_rep !== null &&
        row.source_rep === null &&
        row.source_embedded_project_id !== null
      ) {
        candidateEmbeddedIds.add(row.source_embedded_project_id);
      }
    }
    await Promise.all(
      [...candidateEmbeddedIds].map(async (embeddedProjectId) => {
        try {
          await resolveReadableProjectById(db, actor, embeddedProjectId);
        } catch {
          lockedEmbeddedProjectIds.add(embeddedProjectId);
        }
      }),
    );
  }

  // Partition each surviving row into an interior edge (both ends on-scope) or an
  // interior edge plus a boundary proxy for the one off-scope end. The SQL filter
  // already dropped the collapse and not-rendered cases, so every row here has at
  // least one representative; the per-edge synthetic proxy id is `proxy_<edgeId>`
  // (ADR-0031).
  const interiorEdges: CanvasInteriorEdge[] = [];
  const boundaryProxies: CanvasBoundaryProxy[] = [];
  for (const row of crossScopeRows) {
    const base = {
      id: row.id,
      sourceId: row.source_id,
      targetId: row.target_id,
      interaction: row.interaction,
      label: row.label,
    };
    if (row.source_rep !== null && row.target_rep !== null) {
      interiorEdges.push({
        ...base,
        sourceRepr: row.source_rep,
        targetRepr: row.target_rep,
      });
    } else if (row.source_rep !== null) {
      // Target is off-scope → its boundary proxy stands in on this Canvas.
      const proxyNodeId = `proxy_${row.id}`;
      const placement = placementByEndpoint.get(row.target_id);
      const locked =
        row.target_embedded_project_id !== null &&
        lockedEmbeddedProjectIds.has(row.target_embedded_project_id);
      boundaryProxies.push({
        nodeId: proxyNodeId,
        title: locked ? LOCKED_PORTAL_TITLE : row.target_title,
        kind: row.target_kind,
        realEndpointId: row.target_id,
        edgeId: row.id,
        posX: placement?.posX ?? null,
        posY: placement?.posY ?? null,
      });
      interiorEdges.push({
        ...base,
        sourceRepr: row.source_rep,
        targetRepr: proxyNodeId,
      });
    } else if (row.target_rep !== null) {
      // Source is off-scope → its boundary proxy stands in on this Canvas.
      const proxyNodeId = `proxy_${row.id}`;
      const placement = placementByEndpoint.get(row.source_id);
      const locked =
        row.source_embedded_project_id !== null &&
        lockedEmbeddedProjectIds.has(row.source_embedded_project_id);
      boundaryProxies.push({
        nodeId: proxyNodeId,
        title: locked ? LOCKED_PORTAL_TITLE : row.source_title,
        kind: row.source_kind,
        realEndpointId: row.source_id,
        edgeId: row.id,
        posX: placement?.posX ?? null,
        posY: placement?.posY ?? null,
      });
      interiorEdges.push({
        ...base,
        sourceRepr: proxyNodeId,
        targetRepr: row.target_rep,
      });
    }
  }

  // Annotate each interior portal Node (one carrying `embeddedProjectId`) with the
  // DESCENDING ACTOR's access tier to its target, resolved per-actor (#120):
  //   - `resolveReadableProjectById` throws (capability `none`, or missing/deleted) →
  //     `locked` — all indistinguishable, non-disclosure;
  //   - `viewerCapability === "view"`                       → `readOnly`;
  //   - `capabilityAtLeast(cap, "edit")` (edit/admin/owner) → `enterable`.
  // The per-portal re-resolves run in parallel (no waterfall); a typical Canvas has
  // few portals, so this stays a handful of point lookups.
  //
  // CRITICAL non-disclosure firewall: the foreign `embeddedProjectId` is the real
  // internal Project.id of a project the host owner may have NO grant to — it must
  // NEVER reach the wire. We strip it from EVERY interior node and emit only a
  // non-identifying `isPortal` boolean discriminator (the client keys descent off the
  // portal NODE id, never the embedded project id). Redacting uniformly — every tier
  // alike — keeps the firewall total. A `locked` portal goes further: its stored
  // `title` is the foreign project's title (captured at embed time), so we REPLACE it
  // with `LOCKED_PORTAL_TITLE` — a locked portal carries neither foreign id nor
  // foreign title, only the host node's acknowledged existence.
  const annotatedInteriorNodes = await Promise.all(
    interiorNodes.map(
      async (
        node,
      ): Promise<
        Omit<Node, "embeddedProjectId"> & {
          isPortal: boolean;
          embedAccess?: "enterable" | "readOnly" | "locked";
        }
      > => {
        const { embeddedProjectId, ...rest } = node;
        if (embeddedProjectId === null) return { ...rest, isPortal: false };
        try {
          const { viewerCapability } = await resolveReadableProjectById(
            db,
            actor,
            embeddedProjectId,
          );
          return {
            ...rest,
            isPortal: true,
            embedAccess: capabilityAtLeast(viewerCapability, "edit")
              ? "enterable"
              : "readOnly",
          };
        } catch {
          return {
            ...rest,
            title: LOCKED_PORTAL_TITLE,
            isPortal: true,
            embedAccess: "locked",
          };
        }
      },
    ),
  );

  return {
    interiorNodes: annotatedInteriorNodes,
    interiorEdges,
    boundaryProxies,
    breadcrumbs,
    embedTrail,
    activeProject: {
      id: activeProjectRow.id,
      title: activeProjectRow.title,
      canEdit: capabilityAtLeast(activeCapability, "edit"),
    },
  };
}

/** A Component as the project-wide "Connect to…" search returns it (#66). */
export interface ProjectComponent {
  id: string;
  title: string;
  kind: NodeKind;
  parentId: string | null;
}

/**
 * Lists EVERY live Component in the Project — a flat, scope-independent read that
 * powers the project-wide "Connect to…" search surface (#66 / ADR-0032). Returns
 * `{ id, title, kind, parentId }` per Component; the flat `parentId` lets the
 * client rebuild each Component's ancestor path for disambiguation with zero
 * extra server cost (a live Node's ancestors are always live — the subtree
 * soft-delete cascade keeps the chain intact in the result), so there is no
 * per-Component breadcrumb walk here.
 *
 * Deliberately distinct from the scope-keyed `getCanvas` (different cardinality —
 * the whole Project vs one Canvas; ADR-0032), and NOT folded into its CTE.
 * Capability-gated on `view` via the slug→project bind (ADR-0040): the default
 * `guestAccess=VIEW` reproduces the old slug grant; a `guestAccess=NONE` project
 * is not-found for a non-member. A missing / soft-deleted slug is also not-found.
 */
export async function listProjectComponents(
  db: Db,
  actor: Actor | null,
  input: ListProjectComponentsInput,
): Promise<ProjectComponent[]> {
  const { slug } = listProjectComponentsInput.parse(input);

  const project = await resolveReadableProject(db, actor, slug);

  return db.node.findMany({
    where: { projectId: project.id, deletedAt: null },
    select: { id: true, title: true, kind: true, parentId: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Renames a Component (updates a Node's `title`). Addressed by the Node `id`,
 * not a projectId: the Node is loaded, its Project resolved, and the write
 * authorized through `access-db.authorizeProjectWrite(…, "edit")` — `edit`
 * capability (owner, ADMIN, or EDITOR member; ADR-0040). Load-then-authorize is
 * the natural shape for an existing row and matches how a future MCP "rename"
 * tool arrives — it holds a node id, not a project handle. The actor identity
 * comes from the session, never from `input`.
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
  await authorizeProjectWrite(db, actor, node.projectId, "edit");

  return db.node.update({ where: { id: node.id }, data: { title } });
}

/**
 * Changes a Component's `kind`. Same load-then-authorize shape as `updateNode`
 * (find the live Node, resolve its Project, authorize via
 * `authorizeProjectWrite(…, "edit")` — `edit` capability: owner, ADMIN, or EDITOR
 * member; ADR-0040) — a separate narrow mutation so the kind palette commits only
 * `{ id, kind }`. The actor identity comes from the session, never `input`.
 *
 * Kind is cosmetic (CONTEXT.md "Component kind"; ADR-0018): this is a single
 * `kind` write with NO cascade — no Edge or Spec is touched, because none of
 * them depend on kind. Any `kind` is accepted regardless of the parent's
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
  await authorizeProjectWrite(db, actor, node.projectId, "edit");

  return db.node.update({ where: { id: node.id }, data: { kind } });
}

/**
 * Edits a Component's markdown `documentation`. Same load-then-authorize shape
 * as `updateNode` (find the live Node, resolve its Project, authorize via
 * `authorizeProjectWrite(…, "edit")` — `edit` capability: owner, ADMIN, or EDITOR
 * member; ADR-0040) — a separate narrow mutation so the canvas autosave commits
 * only `{ id, documentation }` per debounced keystroke without re-sending the
 * title. The actor identity comes from the session, never `input`.
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
  await authorizeProjectWrite(db, actor, node.projectId, "edit");

  return db.node.update({ where: { id: node.id }, data: { documentation } });
}

/**
 * Reparents a Component to a new Canvas scope. Same load-then-authorize shape
 * as the other narrow Node mutations; the new scope is `parentId` (null = the
 * Project root; a Node id = that Component's interior Canvas). Ownership comes
 * from the actor, never `input` (ADR-0001). The MCP `move_component` tool is
 * the canonical caller; there is no web/tRPC counterpart yet.
 *
 * Structural but deliberately NON-cascading — ONE reject keeps the graph honest:
 *
 * CYCLE → {@link ValidationError}. The new parent must not be the Node itself or
 * any of its descendants. We compute the subtree of `node` (the recursive
 * `parentId` walk `deleteNode` uses) and reject when `parentId` falls inside it —
 * depth-0 self-parent and any deeper ancestor-onto-descendant case in one shot.
 * BAD_REQUEST: the request is malformed for THIS node; no state change makes it
 * valid.
 *
 * There is NO orphan-reject (retired with ADR-0028). The old reject existed only
 * because the same-Canvas invariant (ADR-0005) pinned a Component's incident
 * Edges to its Canvas, so a reparent would strand them. Connections may now span
 * scopes, so a reparented Component's incident Connections simply become
 * cross-scope — there is nothing to orphan, and no incident-edge check is needed.
 *
 * Idempotent: a move to the current parent is a no-op (returns the node
 * unchanged). Atomicity: this function makes multiple reads plus one write, so
 * the caller MUST wrap it in `db.$transaction` (the MCP tool handler does).
 *
 * See ADR-0024 (the cycle reject; its orphan reject is superseded by ADR-0028).
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
  await authorizeProjectWrite(db, actor, node.projectId, "edit");

  // Idempotent: a move that doesn't change `parentId` is a no-op. Return the
  // full Node row so the caller's optimistic UI / tool result still has it.
  // Filter `deletedAt` here too — under READ COMMITTED, a concurrent
  // soft-delete can become visible between the initial `findFirst` and this
  // read, and the no-op path must not hand back a tombstoned row.
  if (parentId === node.parentId) {
    const current = await db.node.findFirst({
      where: { id: node.id, deletedAt: null },
    });
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
      select: { id: true, embeddedProjectId: true },
    });
    if (!parent) {
      throw new NotFoundError();
    }
    // A portal Component has no host interior; a node can never be moved into
    // one (#121, ADR-0042). Rejected before the cycle/orphan computation so the
    // illegal target never reaches the graph walk.
    if (parent.embeddedProjectId !== null) {
      throw new ValidationError(
        "A portal Component has no interior; embed children belong to the embedded project.",
      );
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

  // Only the moved Node's `parentId` changes; its descendants and its incident
  // Connections travel by identity. An incident Connection that now spans the
  // new scope boundary is simply a cross-scope Connection — valid under
  // ADR-0028, no rescope or reject needed.
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

  const project = await authorizeProjectWrite(db, actor, projectId, "edit");

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
 * Persist where a boundary proxy sits on one scope's Canvas (#91 / ADR-0036). The
 * proxy's IDENTITY stays fully derived (ADR-0031 emits no proxy row); this writes
 * ONLY a view coordinate to `BoundaryProxyPlacement`, joined back additively by
 * `getCanvas`. Owner-only (ADR-0001): authorization comes from the actor against
 * the Project owner, never from `input`.
 *
 * The natural key is `(containerNodeId, realEndpointId)` — the SCOPE's container
 * (null at the root scope) plus the off-scope endpoint, the COALESCED key (#90),
 * never the per-edge `proxy_<edgeId>` view id. Both Node ids are confirmed live in
 * THIS Project before writing (the `updatePositions` set-membership posture), so a
 * foreign or soft-deleted id can never place a row; `containerNodeId === null` is
 * the legitimate root scope and skips the container check.
 *
 * Upsert by hand, NOT via `db.boundaryProxyPlacement.upsert`: the uniqueness lives
 * in a hand-authored `NULLS NOT DISTINCT` partial index (ADR-0010), not an
 * `@@unique`, so Prisma generates NO compound `WhereUniqueInput` to upsert against,
 * and even a generated one would not honour NULLS-NOT-DISTINCT for the root-scope
 * `null` case. `findFirst` + branch is the service-primary path; the `P2002`
 * backstop catches the READ-COMMITTED race where two concurrent first-drags of the
 * same proxy both miss the find and one loses the insert — re-resolve and update
 * the winner's row rather than surfacing a spurious conflict (ADR-0010
 * service-primary + index-backstop).
 */
export async function upsertBoundaryProxyPlacement(
  db: Db,
  actor: Actor,
  input: UpsertBoundaryProxyPlacementInput,
): Promise<{ posX: number; posY: number }> {
  const { projectId, containerNodeId, realEndpointId, posX, posY } =
    upsertBoundaryProxyPlacementInput.parse(input);

  const project = await authorizeProjectWrite(db, actor, projectId, "edit");

  // Both endpoints must be live Nodes in this (owned) Project — the off-scope
  // endpoint always, the container only when non-null (null is the root scope,
  // which has no container Component). A foreign or soft-deleted id surfaces as
  // not-found rather than placing an orphan row (mirrors `updatePositions`).
  const requiredIds =
    containerNodeId === null
      ? [realEndpointId]
      : [containerNodeId, realEndpointId];
  const live = await db.node.findMany({
    where: {
      projectId: project.id,
      id: { in: requiredIds },
      deletedAt: null,
    },
    select: { id: true },
  });
  if (live.length !== new Set(requiredIds).size) {
    throw new NotFoundError();
  }

  const existing = await db.boundaryProxyPlacement.findFirst({
    where: { containerNodeId, realEndpointId },
    select: { id: true },
  });
  if (existing) {
    const updated = await db.boundaryProxyPlacement.update({
      where: { id: existing.id },
      data: { posX, posY },
      select: { posX: true, posY: true },
    });
    return updated;
  }

  try {
    const created = await db.boundaryProxyPlacement.create({
      data: { containerNodeId, realEndpointId, posX, posY },
      select: { posX: true, posY: true },
    });
    return created;
  } catch (error) {
    // Lost the insert race against a concurrent first-drag of the same proxy:
    // the row now exists, so update it instead of surfacing a phantom conflict.
    if (isPrismaUniqueViolation(error)) {
      const row = await db.boundaryProxyPlacement.findFirst({
        where: { containerNodeId, realEndpointId },
        select: { id: true },
      });
      if (row) {
        return db.boundaryProxyPlacement.update({
          where: { id: row.id },
          data: { posX, posY },
          select: { posX: true, posY: true },
        });
      }
    }
    throw error;
  }
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
 * subtree (every Node descending through `parentId` — including any spec-derived
 * child Components, which are ordinary children), every incident or interior
 * Connection, and the owned Spec are flagged `deletedAt` in ONE atomic
 * operation, all stamped with one fresh `deletionId` so the whole set can be
 * undone as a unit (`restoreNode`; ADR-0008 + ADR-0030). The safety net that
 * matters because AI agents mutate the graph (CONTEXT.md "Soft-delete + undo").
 *
 * Addressed by the Node `id`; loaded, its Project resolved, and authorized via
 * `authorizeProjectWrite(…, "edit")` — `edit` capability (owner, ADMIN, or EDITOR
 * member; ADR-0040) — BEFORE the subtree is gathered, so a denied caller learns
 * nothing about the graph's shape. Idempotent in spirit: an already-deleted
 * Component reads as not-found (like `deleteEdge`).
 *
 * The subtree is gathered in a SINGLE recursive CTE descending `parentId` — the
 * mirror of `getCanvas`'s ascending breadcrumb walk — never a per-level loop
 * (ADR-0006, whose raw-SQL discipline this reuses: double-quoted PascalCase
 * identifiers, bound params, `deletedAt IS NULL` on both arms). Filtering
 * `deletedAt IS NULL` on the recursive step is safe because no live Node ever
 * sits under a soft-deleted ancestor (a cascade sweeps the whole subtree, and
 * `createNode` rejects a soft-deleted parent), so the walk never needs to pass
 * THROUGH a deleted Node to reach a live descendant.
 *
 * The Edge sweep is `sourceId ∈ S OR targetId ∈ S` (S = the subtree): a
 * Connection incident to ANY swept Component — same-Canvas, cross-scope, or an
 * "incident" one up to a surviving sibling — touches a swept endpoint and is
 * caught. With scope no longer stored (ADR-0028), endpoint membership is the
 * whole predicate. The Spec sweep is simpler — it has one FK into Node
 * (`ownerNodeId`). All `updateMany`s filter `deletedAt: null`, so a Connection /
 * Spec the user had already removed via its own lone delete is NOT re-stamped —
 * and so `restoreNode` never revives it.
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
  specIds: string[];
}> {
  const { id } = deleteNodeInput.parse(input);

  const node = await db.node.findFirst({
    where: { id, deletedAt: null },
    select: { id: true, projectId: true },
  });
  if (!node) {
    throw new NotFoundError();
  }
  await authorizeProjectWrite(db, actor, node.projectId, "edit");

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

  // The Edge sweep: any live Edge with an endpoint in the subtree. Capture the
  // ids first (for the optimistic-UI return), then stamp the same live set.
  const edgeWhere = {
    projectId: node.projectId,
    deletedAt: null,
    OR: [{ sourceId: { in: nodeIds } }, { targetId: { in: nodeIds } }],
  };
  const sweptEdges = await db.edge.findMany({
    where: edgeWhere,
    select: { id: true },
  });
  const edgeIds = sweptEdges.map((edge) => edge.id);

  // Spec sweep (ADR-0030): the owned Spec (1:1) on any Node in the subtree. One
  // FK column to union over (`ownerNodeId`), unlike Edge's two. The
  // `deletedAt: null` filter is load-bearing — a Spec already removed must NOT
  // be re-stamped, or `restoreNode` would wrongly revive it as part of this
  // batch. (Spec-derived child Components are ordinary subtree Nodes and ride
  // the Node sweep — no separate arm.)
  const specWhere = {
    projectId: node.projectId,
    ownerNodeId: { in: nodeIds },
    deletedAt: null,
  };
  const sweptSpecs = await db.spec.findMany({
    where: specWhere,
    select: { id: true },
  });
  const specIds = sweptSpecs.map((s) => s.id);

  await db.node.updateMany({
    where: { id: { in: nodeIds }, deletedAt: null },
    data: { deletedAt, deletionId },
  });
  await db.edge.updateMany({
    where: edgeWhere,
    data: { deletedAt, deletionId },
  });
  await db.spec.updateMany({
    where: specWhere,
    data: { deletedAt, deletionId },
  });

  // Post-stamp guard (ADR-0008): the sequential cascade always gathers every live
  // descendant, so a live child still sitting directly under the freshly-stamped
  // set means a concurrent createNode raced us between the subtree read and this
  // commit. Fail loud rather than leave a silent, unrecoverable orphan.
  await assertNoOrphanedChildren(db, nodeIds);

  return { deletionId, nodeIds, edgeIds, specIds };
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
 * Undo is a WRITE — requires `edit` capability (owner, ADMIN, or EDITOR member;
 * ADR-0040). The Project is resolved from the stamped rows (never from input),
 * then authorized through `authorizeProjectWrite(…, "edit")` (ADR-0001/0002); a
 * read-only (guest-VIEW) viewer cannot undo. An unknown or already-restored
 * `deletionId` matches no rows and reads as not-found.
 *
 * Restore is "as-is": if an ancestor of this batch was independently deleted in
 * a LATER operation, the restored subtree is briefly unreachable via `getCanvas`
 * until that ancestor is also restored — honoring "restore exactly the affected
 * set and nothing outside it" literally.
 *
 * MUST run inside the caller's transaction (the router wraps it in
 * `db.$transaction`). All dedup pre-checks run before any `updateMany`, but the
 * Edge revival can still lose a race to a concurrent writer and throw AFTER the
 * Node revival has already committed its statement; correctness then rests on
 * the transaction aborting and rolling the Node revival back. Outside a
 * transaction that throw would leave Nodes revived with their Edges still
 * tombstoned.
 */
export async function restoreNode(
  db: Db,
  actor: Actor,
  input: RestoreNodeInput,
): Promise<{
  deletionId: string;
  nodeIds: string[];
  edgeIds: string[];
  specIds: string[];
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
  await authorizeProjectWrite(db, actor, firstNode.projectId, "edit");

  const edges = await db.edge.findMany({
    where: { deletionId },
    select: {
      id: true,
      projectId: true,
      sourceId: true,
      targetId: true,
      interaction: true,
    },
  });
  const stampedSpecs = await db.spec.findMany({
    where: { deletionId },
    select: { id: true, ownerNodeId: true },
  });

  // Pre-check the Edge de-dupe invariant (ADR-0010): any active row occupying a
  // slot we're about to revive would block the updateMany. Each revived Edge
  // contributes its interaction-appropriate predicate (association → unordered
  // pair; directional → ordered triple + interaction). Done BEFORE the updates
  // because Postgres aborts the transaction on P2002 and we couldn't query for
  // diagnostics from inside the catch.
  if (edges.length > 0) {
    const conflicts = await db.edge.findMany({
      where: {
        deletedAt: null,
        OR: edges.map(({ projectId, sourceId, targetId, interaction }) =>
          activeDuplicateWhere(projectId, sourceId, targetId, interaction),
        ),
      },
      select: { id: true },
    });
    if (conflicts.length > 0) {
      const count = conflicts.length;
      throw new ConflictError(
        `Can't undo this delete: ${count} Connection${count === 1 ? "" : "s"} cannot be restored because a new Connection now occupies the same slot. Delete the conflicting Connection${count === 1 ? "" : "s"} and retry.`,
        { conflictingEdgeIds: conflicts.map((e) => e.id) },
      );
    }
  }

  // Spec is live-only 1:1 with its owner Node (partial index
  // `idx_spec_owner_live`); restoring a stamped Spec collides if the user
  // attached a fresh Spec to the same Node since the delete. Same readable-error
  // posture as the Edge case.
  if (stampedSpecs.length > 0) {
    const conflicts = await db.spec.findMany({
      where: {
        deletedAt: null,
        ownerNodeId: { in: stampedSpecs.map((s) => s.ownerNodeId) },
      },
      select: { id: true },
    });
    if (conflicts.length > 0) {
      const count = conflicts.length;
      throw new ConflictError(
        `Can't undo this delete: ${count} Spec${count === 1 ? "" : "s"} cannot be restored because a new Spec now occupies the same Component. Delete the conflicting Spec${count === 1 ? "" : "s"} and retry.`,
        { conflictingSpecIds: conflicts.map((s) => s.id) },
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

  await db.spec.updateMany({
    where: { deletionId },
    data: { deletedAt: null, deletionId: null },
  });

  return {
    deletionId,
    nodeIds: nodes.map((n) => n.id),
    edgeIds: edges.map((e) => e.id),
    specIds: stampedSpecs.map((s) => s.id),
  };
}
