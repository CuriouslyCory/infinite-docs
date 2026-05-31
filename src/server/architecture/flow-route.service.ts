import { randomUUID } from "node:crypto";

import { type FlowRoute } from "../../../generated/prisma/client";
import { assertCanRead, assertCanWrite } from "./access";
import type { Actor, Db } from "./actor";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import {
  getRoutedFlowIdsForEdgeInput,
  routeFlowInput,
  unrouteFlowInput,
  type GetRoutedFlowIdsForEdgeInput,
  type RouteFlowInput,
  type UnrouteFlowInput,
} from "~/lib/schemas";

/**
 * Binds a Flow to a Connection (creates a FlowRoute). Two shapes, discriminated
 * by whether `sourceNodeId` / `targetNodeId` are supplied (see `routeFlowInput`):
 *
 * - **Same-Canvas baseline** (Slice 2): `innerEdgeId = null` — "this pipe
 *   carries this Flow."
 * - **Cross-scope refinement** (Slice 3 / ADR-0012): find-or-creates the inner
 *   Edge one scope deeper and binds it — "this Flow continues as that interior
 *   Connection." THE single gated exception to ADR-0005's same-Canvas rule,
 *   isolated in `resolveInnerEdgeId` below; `connectNodes` stays strict.
 *
 * Invariants enforced, in order:
 *
 * 1. **Flow exists and is live.** Loaded by `flowId`; soft-deleted reads as
 *    not-found.
 * 2. **Outer Edge exists, is live, and shares the Project.** A Flow from one
 *    Project routed onto an Edge in another surfaces as not-found (the same
 *    set-membership posture `connectNodes` uses for endpoints).
 * 3. **Owner-only.** Project loaded from the Flow's `projectId`; authorized
 *    through `access.assertCanWrite` (ADR-0001). Never slug-granted (ADR-0002).
 * 4. **Flow's owner touches the outer Edge.** `flow.ownerNodeId` must equal
 *    `edge.sourceId` OR `edge.targetId`. The precondition for the polarity
 *    invariant below: "owner isn't even on this edge" is a distinct (and
 *    non-discriminable) error from "owner is on the wrong end".
 * 4b. **Polarity matches the structural arrow** (Slice 4 / ADR-0013). INBOUND ⇒
 *    `flow.ownerNodeId === edge.targetId` (arrow points at the owner that
 *    consumes); OUTBOUND ⇒ `flow.ownerNodeId === edge.sourceId` (arrow points
 *    away from the owner that emits). A mismatch throws a discriminable
 *    `ValidationError` (`details.reason = "POLARITY_MISMATCH"`) the canvas maps
 *    to the reverse-Connection offer; the service is the backstop for non-UI
 *    callers (MCP, #42). Reaffirms ADR-0009: bidirectional traffic is two
 *    Connections, not a reversed arrow.
 * 5. **(cross-scope) The interior endpoint sits inside the outer Edge's other
 *    endpoint, and the boundary endpoint is the Flow's owner** — see
 *    `resolveInnerEdgeId`.
 * 6. **No duplicate active route.** `(outerEdgeId, flowId)` among active rows:
 *    fast-path `findFirst` throws the readable conflict; `createMany`'s
 *    ON CONFLICT DO NOTHING (`idx_flow_route_dedup`) catches the concurrent
 *    racer that slips past. Both translate to the same `ConflictError` shape
 *    with `details.conflictingFlowRouteIds` (ADR-0010 named pattern).
 *
 * The inner-Edge and FlowRoute writes use `createMany({ skipDuplicates })`
 * rather than `create` precisely because ON CONFLICT DO NOTHING never raises
 * P2002 — so when the caller wraps this in `db.$transaction` (the tRPC
 * procedure does), a concurrent racer hitting the unique index does NOT abort
 * the transaction. That is what lets the inner Edge and the FlowRoute commit
 * atomically with no retry loop, and what lets two refinements over the same
 * interior pair converge on one shared inner Edge (ADR-0012).
 */
export async function routeFlow(
  db: Db,
  actor: Actor,
  input: RouteFlowInput,
): Promise<FlowRoute> {
  const { flowId, outerEdgeId, sourceNodeId, targetNodeId } =
    routeFlowInput.parse(input);

  const flow = await db.flow.findFirst({
    where: { id: flowId, deletedAt: null },
    select: { id: true, projectId: true, ownerNodeId: true, polarity: true },
  });
  if (!flow) {
    throw new NotFoundError();
  }

  const edge = await db.edge.findFirst({
    where: { id: outerEdgeId, deletedAt: null },
    select: { id: true, projectId: true, sourceId: true, targetId: true },
  });
  if (!edge) {
    throw new NotFoundError();
  }

  // Cross-project smuggling: an Edge in another Project surfaces as
  // not-found, never as "exists but forbidden" (the same posture
  // `connectNodes` uses to keep a foreign Node id from leaking existence).
  if (flow.projectId !== edge.projectId) {
    throw new NotFoundError();
  }

  const project = await db.project.findFirst({
    where: { id: flow.projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  // Owner-touches-endpoint precondition: the polarity check below assumes the
  // owner is on the Edge at all. "Not an endpoint" is a different (and
  // non-discriminable) error from "the wrong endpoint".
  if (flow.ownerNodeId !== edge.sourceId && flow.ownerNodeId !== edge.targetId) {
    throw new ValidationError(
      "This Flow's owner is not an endpoint of the selected Connection.",
    );
  }

  // Polarity invariant (Slice 4 / ADR-0013). The structural arrow cannot lie
  // (ADR-0009), so a Flow may only ride a Connection oriented its way: an
  // INBOUND Flow's owner consumes, so the arrow must point AT it (owner =
  // target); an OUTBOUND Flow's owner emits, so the arrow points AWAY (owner =
  // source). A mismatch is rejected with a discriminable error the canvas maps
  // to the reverse-Connection offer; routing the other direction means a second
  // Connection, never a reversed arrow.
  const expectedOwnerRole = flow.polarity === "INBOUND" ? "target" : "source";
  const ownerIsCorrectEnd =
    flow.polarity === "INBOUND"
      ? flow.ownerNodeId === edge.targetId
      : flow.ownerNodeId === edge.sourceId;
  if (!ownerIsCorrectEnd) {
    throw new ValidationError(
      flow.polarity === "INBOUND"
        ? "This inbound Flow must ride a Connection that points at its owner. Add the reverse Connection to carry it."
        : "This outbound Flow must ride a Connection that points away from its owner. Add the reverse Connection to carry it.",
      { reason: "POLARITY_MISMATCH", expectedOwnerRole },
    );
  }

  // Cross-scope refinement resolves (find-or-creates) the inner Edge; the
  // same-Canvas baseline leaves it null. Done before the FlowRoute write so
  // both land in the caller's transaction.
  const innerEdgeId =
    sourceNodeId !== undefined && targetNodeId !== undefined
      ? await resolveInnerEdgeId(db, {
          projectId: flow.projectId,
          boundaryNodeId: flow.ownerNodeId,
          outerSourceId: edge.sourceId,
          outerTargetId: edge.targetId,
          sourceNodeId,
          targetNodeId,
        })
      : null;

  // Readable duplicate error for the common case (sequential re-route).
  const duplicate = await db.flowRoute.findFirst({
    where: { outerEdgeId: edge.id, flowId: flow.id, deletedAt: null },
    select: { id: true },
  });
  if (duplicate) {
    throw new ConflictError("This Flow is already routed on that Connection.", {
      conflictingFlowRouteIds: [duplicate.id],
    });
  }

  const created = await db.flowRoute.createMany({
    data: [
      {
        projectId: flow.projectId,
        flowId: flow.id,
        outerEdgeId: edge.id,
        innerEdgeId,
      },
    ],
    skipDuplicates: true,
  });
  if (created.count === 0) {
    // A concurrent racer committed the same (outerEdgeId, flowId) first; the
    // partial unique index made our insert a no-op (ADR-0010). Re-read for the
    // same error shape the fast path produces — safe even inside a transaction
    // because ON CONFLICT DO NOTHING did not abort it.
    const racer = await db.flowRoute.findFirst({
      where: { outerEdgeId: edge.id, flowId: flow.id, deletedAt: null },
      select: { id: true },
    });
    throw new ConflictError("This Flow is already routed on that Connection.", {
      conflictingFlowRouteIds: racer ? [racer.id] : [],
    });
  }

  return db.flowRoute.findFirstOrThrow({
    where: { outerEdgeId: edge.id, flowId: flow.id, deletedAt: null },
  });
}

/**
 * Find-or-creates the inner Edge for a cross-scope refinement route and returns
 * its id. THE single gated exception to ADR-0005's same-Canvas rule (ADR-0012):
 * this is the only place a service writes an Edge where one endpoint's
 * `parentId` differs from the Edge's `canvasNodeId` — and only when that
 * endpoint is the **boundary endpoint** (the Flow's owner, a boundary proxy on
 * the interior Canvas). `connectNodes` stays strict; loosening it is a
 * regression against ADR-0005.
 *
 * The cross-scope endpoint is never named directly by the caller: the boundary
 * endpoint is *derived* from the Flow's owner and required to match one of the
 * supplied endpoints, and the other (interior) endpoint must be a child of the
 * outer Edge's other endpoint. So an arbitrary foreign Node can't be smuggled
 * in as a cross-scope endpoint.
 *
 * The write is `createMany({ skipDuplicates })` — ON CONFLICT DO NOTHING under
 * `idx_edge_dedup` — so two concurrent refinements of the same outer Edge with
 * distinct Flows over the same interior pair converge on ONE shared inner Edge
 * (an Edge is a pipe carrying many Flows; `FlowRoute.innerEdgeId` has no
 * uniqueness). It never raises P2002, so it never aborts the surrounding
 * FlowRoute transaction — no retry loop needed.
 */
async function resolveInnerEdgeId(
  db: Db,
  args: {
    projectId: string;
    boundaryNodeId: string;
    outerSourceId: string;
    outerTargetId: string;
    sourceNodeId: string;
    targetNodeId: string;
  },
): Promise<string> {
  const {
    projectId,
    boundaryNodeId,
    outerSourceId,
    outerTargetId,
    sourceNodeId,
    targetNodeId,
  } = args;

  // Defensive local re-assertion of routeFlow's touches-endpoint guard (step 4):
  // the boundary endpoint must be an endpoint of the outer Edge. routeFlow
  // already checks this before calling, but pinning it here keeps the gated
  // cross-scope write safe under any future caller of this helper (ADR-0012).
  if (boundaryNodeId !== outerSourceId && boundaryNodeId !== outerTargetId) {
    throw new ValidationError(
      "The Flow's owner must be an endpoint of the outer Connection.",
    );
  }

  if (sourceNodeId === targetNodeId) {
    throw new ValidationError(
      "A refinement Connection cannot link a Component to itself.",
    );
  }

  // Exactly one supplied endpoint must be the boundary endpoint — the Flow's
  // owner, already proven (above) an endpoint of the outer Edge. Deriving it
  // and requiring a match (rather than trusting an input flag) is what bounds
  // the ADR-0005 loosening (ADR-0012).
  const boundaryIsSource = sourceNodeId === boundaryNodeId;
  const boundaryIsTarget = targetNodeId === boundaryNodeId;
  if (boundaryIsSource === boundaryIsTarget) {
    throw new ValidationError(
      "One endpoint of the refinement Connection must be the Flow's owner (the boundary proxy).",
    );
  }
  const interiorNodeId = boundaryIsSource ? targetNodeId : sourceNodeId;

  // The inner Edge sits on the interior Canvas of the outer Edge's OTHER
  // endpoint (the consumer for INBOUND, the producer for OUTBOUND). That other
  // endpoint is the scope; the interior endpoint must be one of its children.
  const scopeNodeId =
    boundaryNodeId === outerSourceId ? outerTargetId : outerSourceId;

  const interior = await db.node.findFirst({
    where: { id: interiorNodeId, projectId, deletedAt: null },
    select: { id: true, parentId: true },
  });
  if (!interior) {
    throw new NotFoundError();
  }
  if (interior.parentId !== scopeNodeId) {
    throw new ValidationError(
      "The interior Component must sit on the Canvas inside the Connection's other endpoint.",
    );
  }

  // Find-or-create the inner Edge, then lock it before returning so the
  // FlowRoute the caller is about to write cannot reference an Edge a concurrent
  // sweep (unrouteFlow / deleteEdge) soft-deletes in the gap. Those sweepers take
  // the SAME `FOR UPDATE` on this row before counting referers, so all three
  // cross-scope writers serialize on the inner Edge (ADR-0012). If the row we
  // resolved was swept in the read-then-lock window, `idx_edge_dedup` (partial
  // on `deletedAt IS NULL`) excludes it and `createMany` mints a fresh live Edge
  // on retry; this converges in at most a couple of iterations.
  for (let attempt = 0; ; attempt++) {
    await db.edge.createMany({
      data: [
        {
          projectId,
          canvasNodeId: scopeNodeId,
          sourceId: sourceNodeId,
          targetId: targetNodeId,
        },
      ],
      skipDuplicates: true,
    });
    const inner = await db.edge.findFirstOrThrow({
      where: {
        canvasNodeId: scopeNodeId,
        sourceId: sourceNodeId,
        targetId: targetNodeId,
        deletedAt: null,
      },
      select: { id: true },
    });
    await db.$queryRaw`SELECT id FROM "Edge" WHERE id = ${inner.id} FOR UPDATE`;
    const stillLive = await db.edge.findFirst({
      where: { id: inner.id, deletedAt: null },
      select: { id: true },
    });
    if (stillLive) {
      return inner.id;
    }
    if (attempt >= 4) {
      throw new ConflictError(
        "The interior Connection is being removed concurrently. Please retry.",
      );
    }
  }
}

/**
 * Removes a FlowRoute via soft-delete. Idempotent in spirit: an
 * already-deleted FlowRoute reads as not-found. Owner-only.
 *
 * Cascade (Slice 3 / ADR-0012 + ADR-0014): a cross-scope FlowRoute owns an
 * inner Edge, but that Edge is a pipe — other active FlowRoutes may share it
 * (two Flows refined over the same interior pair converge on one inner Edge).
 * So this sweeps the inner Edge ONLY when no OTHER active FlowRoute references
 * it. When it does, it mints one `deletionId` and stamps both rows, so
 * `restoreEdge` revives them as a unit; otherwise it is a lone soft-delete
 * with no `deletionId` (ADR-0008's lone-delete rule, matching the baseline and
 * `deleteEdge`/`deleteFlow`/`deleteNode`). Re-routing the same
 * (flowId, outerEdgeId) pair afterward works — `idx_flow_route_dedup` excludes
 * soft-deleted rows.
 *
 * Wrap callers in `db.$transaction` so the FlowRoute and inner-Edge sweeps
 * commit atomically (the tRPC procedure does).
 */
export async function unrouteFlow(
  db: Db,
  actor: Actor,
  input: UnrouteFlowInput,
): Promise<FlowRoute> {
  const { flowRouteId } = unrouteFlowInput.parse(input);

  const flowRoute = await db.flowRoute.findFirst({
    where: { id: flowRouteId, deletedAt: null },
    select: { id: true, projectId: true, innerEdgeId: true },
  });
  if (!flowRoute) {
    throw new NotFoundError();
  }
  const project = await db.project.findFirst({
    where: { id: flowRoute.projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  const deletedAt = new Date();

  // A shared inner Edge survives this unroute as long as another active
  // FlowRoute still references it — the count EXCLUDES the row being deleted.
  if (flowRoute.innerEdgeId) {
    // Serialize the last-referer decision per inner Edge. Without this lock two
    // concurrent unroutes of the last two routes sharing the Edge could each
    // see the OTHER still active (READ COMMITTED), both take the lone-delete
    // branch, and leave the inner Edge active with zero active routes — an
    // orphaned pipe that breaks ADR-0014's restore-as-a-unit guarantee. The
    // lock (the same row routeFlow / deleteEdge take) releases on the caller's
    // transaction commit; readers never contend for it (ADR-0012).
    await db.$queryRaw`SELECT id FROM "Edge" WHERE id = ${flowRoute.innerEdgeId} FOR UPDATE`;
    const otherReferers = await db.flowRoute.count({
      where: {
        innerEdgeId: flowRoute.innerEdgeId,
        deletedAt: null,
        id: { not: flowRoute.id },
      },
    });
    if (otherReferers === 0) {
      const deletionId = randomUUID();
      const updated = await db.flowRoute.update({
        where: { id: flowRoute.id },
        data: { deletedAt, deletionId },
      });
      await db.edge.updateMany({
        where: { id: flowRoute.innerEdgeId, deletedAt: null },
        data: { deletedAt, deletionId },
      });
      return updated;
    }
  }

  return db.flowRoute.update({
    where: { id: flowRoute.id },
    data: { deletedAt },
  });
}

/**
 * Reads the active FlowRoute flowIds on an outer Edge — the unrouted-filter
 * helper for the "+ flow" popover (Slice 2 UI). Just the flowIds; the popover
 * already has the endpoint Flow lists from `getFlowsForNode` and only needs
 * to know which of those to hide.
 *
 * Read access is via the capability slug (ADR-0002): the panel works in
 * shared-view mode. The service confirms the `outerEdgeId` belongs to the
 * slugged Project, so a slug for one project cannot peek at routes in
 * another.
 */
export async function getRoutedFlowIdsForEdge(
  db: Db,
  actor: Actor | null,
  input: GetRoutedFlowIdsForEdgeInput,
): Promise<string[]> {
  const { outerEdgeId, slug } = getRoutedFlowIdsForEdgeInput.parse(input);

  const project = await db.project.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanRead(actor, project, { viaCapabilitySlug: true });

  const edge = await db.edge.findFirst({
    where: { id: outerEdgeId, projectId: project.id, deletedAt: null },
    select: { id: true },
  });
  if (!edge) {
    throw new NotFoundError();
  }

  const routes = await db.flowRoute.findMany({
    where: { outerEdgeId: edge.id, deletedAt: null },
    select: { flowId: true },
  });
  return routes.map((r) => r.flowId);
}
