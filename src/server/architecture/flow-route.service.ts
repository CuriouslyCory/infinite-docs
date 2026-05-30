import { type FlowRoute } from "../../../generated/prisma/client";
import { assertCanRead, assertCanWrite } from "./access";
import type { Actor, Db } from "./actor";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { isFlowRouteDedupCollision } from "./prisma-errors";
import {
  getRoutedFlowIdsForEdgeInput,
  routeFlowInput,
  unrouteFlowInput,
  type GetRoutedFlowIdsForEdgeInput,
  type RouteFlowInput,
  type UnrouteFlowInput,
} from "~/lib/schemas";

/**
 * Binds a Flow to a Connection (creates a FlowRoute) — the same-Canvas
 * baseline writer. Slice 2 of the flow-routed-connections plan.
 *
 * Five invariants the service enforces, in order:
 *
 * 1. **Flow exists and is live.** Loaded by `flowId`; soft-deleted reads as
 *    not-found.
 * 2. **Outer Edge exists, is live, and shares the Project.** Loaded by
 *    `outerEdgeId`; a Flow from one Project routed onto an Edge in another
 *    surfaces as not-found (the same set-membership posture `connectNodes`
 *    uses for endpoints).
 * 3. **Owner-only.** Project loaded from the Flow's `projectId`; authorized
 *    through `access.assertCanWrite` (ADR-0001). Writes are never
 *    slug-granted (ADR-0002).
 * 4. **Flow's owner touches the outer Edge.** `flow.ownerNodeId` must equal
 *    `edge.sourceId` OR `edge.targetId` — the *weaker* form of the eventual
 *    polarity invariant (Slice 4 / ADR-0013 will refine to "INBOUND ⇒ owner
 *    = target; OUTBOUND ⇒ owner = source"). This service is direction-blind
 *    by design — Slice 4's reverse-Connection UX needs the loose check to
 *    detect mismatch and offer the reverse.
 * 5. **No duplicate active route.** `(outerEdgeId, flowId)` among active
 *    rows: fast-path `findFirst` throws the readable conflict; the partial
 *    unique index `idx_flow_route_dedup` catches the concurrent racer that
 *    slips past. Both translate to the same `ConflictError` shape with
 *    `details.conflictingFlowRouteIds`. ADR-0010 named pattern, third
 *    adopter.
 *
 * Same-Canvas baseline only: the schema's `innerEdgeId` is kept ahead of its
 * writer (Slice 3 / ADR-0012), but `routeFlowInput` has no field to set it
 * — narrow+required (memory). Slice 3 adds the field additively when the
 * gated cross-scope writer lands.
 */
export async function routeFlow(
  db: Db,
  actor: Actor,
  input: RouteFlowInput,
): Promise<FlowRoute> {
  const { flowId, outerEdgeId } = routeFlowInput.parse(input);

  const flow = await db.flow.findFirst({
    where: { id: flowId, deletedAt: null },
    select: { id: true, projectId: true, ownerNodeId: true },
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

  // Owner-touches-endpoint (Slice 2 invariant; the polarity refinement is
  // Slice 4). Direction-blind on purpose so the canvas UI can detect a
  // polarity mismatch and offer the reverse-Connection UX (Slice 4 / #37).
  if (flow.ownerNodeId !== edge.sourceId && flow.ownerNodeId !== edge.targetId) {
    throw new ValidationError(
      "This Flow's owner is not an endpoint of the selected Connection.",
    );
  }

  const duplicate = await db.flowRoute.findFirst({
    where: { outerEdgeId: edge.id, flowId: flow.id, deletedAt: null },
    select: { id: true },
  });
  if (duplicate) {
    throw new ConflictError("This Flow is already routed on that Connection.", {
      conflictingFlowRouteIds: [duplicate.id],
    });
  }

  try {
    return await db.flowRoute.create({
      data: {
        projectId: flow.projectId,
        flowId: flow.id,
        outerEdgeId: edge.id,
      },
    });
  } catch (error) {
    if (!isFlowRouteDedupCollision(error)) throw error;
    // The fast-path `findFirst` missed a concurrent racer that committed
    // first; the partial unique index caught it (ADR-0010). Load the racer
    // so the catch path produces the same error shape as the fast path.
    const racer = await db.flowRoute.findFirst({
      where: { outerEdgeId: edge.id, flowId: flow.id, deletedAt: null },
      select: { id: true },
    });
    throw new ConflictError("This Flow is already routed on that Connection.", {
      conflictingFlowRouteIds: racer ? [racer.id] : [],
    });
  }
}

/**
 * Removes a FlowRoute via soft-delete. Idempotent in spirit: an
 * already-deleted FlowRoute reads as not-found. A lone `unrouteFlow` does
 * NOT mint a `deletionId` — that handle ties cascading-batch deletes only
 * (ADR-0008); the lone case matches `deleteEdge` / `deleteFlow` /
 * `deleteNode`'s lone behaviour. Re-routing the same (flowId, outerEdgeId)
 * pair after `unrouteFlow` is supported — the `idx_flow_route_dedup` partial
 * index excludes soft-deleted rows (ADR-0010 precondition c). Owner-only.
 */
export async function unrouteFlow(
  db: Db,
  actor: Actor,
  input: UnrouteFlowInput,
): Promise<FlowRoute> {
  const { flowRouteId } = unrouteFlowInput.parse(input);

  const flowRoute = await db.flowRoute.findFirst({
    where: { id: flowRouteId, deletedAt: null },
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

  return db.flowRoute.update({
    where: { id: flowRoute.id },
    data: { deletedAt: new Date() },
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
