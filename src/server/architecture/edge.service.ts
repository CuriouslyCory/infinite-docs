import { randomUUID } from "node:crypto";

import { type Edge } from "../../../generated/prisma/client";
import { assertCanWrite } from "./access";
import type { Actor, Db } from "./actor";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import {
  isEdgeDedupCollision,
  isFlowRouteDedupCollision,
} from "./prisma-errors";
import {
  connectNodesInput,
  deleteEdgeInput,
  restoreEdgeInput,
  updateEdgeInput,
  type ConnectNodesInput,
  type DeleteEdgeInput,
  type RestoreEdgeInput,
  type UpdateEdgeInput,
} from "~/lib/schemas";

/**
 * Draws a Connection (creates an Edge) between two Components on one Canvas.
 *
 * The Canvas is the EXPLICIT `canvasNodeId` (null => the Project root) — it is
 * supplied, never inferred from the endpoints, so a future refinement
 * Connection can span scope levels without a model change (ADR-0005). Three
 * invariants are enforced here in the service; the de-dupe invariant
 * additionally has the partial unique index `idx_edge_dedup` as a TOCTOU
 * backstop (ADR-0010), surfaced as the same `ConflictError` shape on both
 * paths (`details.conflictingEdgeIds` names the active Edge that blocked the
 * write):
 *
 * 1. no self-Connection (`sourceId !== targetId`);
 * 2. same-Canvas — both endpoints' `parentId` equals `canvasNodeId`;
 * 3. no duplicate ACTIVE Edge sharing source + target + scope (A→B is distinct
 *    from B→A — the ordered pair IS the direction; the label never factors in;
 *    a soft-deleted Edge never blocks re-creation). Fast-path `findFirst`
 *    throws the readable conflict; the partial unique index catches the
 *    concurrent racer that slips past, both translated to the same error.
 *
 * Owner-only: the Project is addressed by `projectId` (an internal handle,
 * never the capability slug — writes are never slug-granted, ADR-0002) and the
 * write is authorized through `access.assertCanWrite` against `project.ownerId`.
 * Ownership comes from the actor, never from `input` (ADR-0001). `label` is
 * UNTRUSTED user content, stored verbatim (prompt-injection standing note).
 */
export async function connectNodes(
  db: Db,
  actor: Actor,
  input: ConnectNodesInput,
): Promise<Edge> {
  const { projectId, canvasNodeId, sourceId, targetId, label } =
    connectNodesInput.parse(input);

  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  if (sourceId === targetId) {
    throw new ValidationError(
      "A Connection cannot link a Component to itself.",
    );
  }

  // Both endpoints must be live Nodes in this owned Project. Scoping the lookup
  // to `projectId` closes cross-project smuggling (a foreign Node id can never
  // be an endpoint) and never reveals whether the id exists elsewhere — the
  // same set-membership posture `updatePositions` uses for batch writes.
  const endpoints = await db.node.findMany({
    where: {
      id: { in: [sourceId, targetId] },
      projectId: project.id,
      deletedAt: null,
    },
    select: { id: true, parentId: true },
  });
  const source = endpoints.find((n) => n.id === sourceId);
  const target = endpoints.find((n) => n.id === targetId);
  if (!source || !target) {
    throw new NotFoundError();
  }

  // Same-Canvas: confirm the explicit `canvasNodeId` matches where the endpoints
  // actually live (null === null at the root). This also rejects a bogus scope
  // that does not match either endpoint.
  if (source.parentId !== canvasNodeId || target.parentId !== canvasNodeId) {
    throw new ValidationError(
      "Both Components must be on the Canvas the Connection is drawn on.",
    );
  }

  const duplicate = await db.edge.findFirst({
    where: { canvasNodeId, sourceId, targetId, deletedAt: null },
    select: { id: true, label: true },
  });
  if (duplicate) {
    throw new ConflictError(duplicateConnectionMessage(duplicate.label), {
      conflictingEdgeIds: [duplicate.id],
    });
  }

  try {
    return await db.edge.create({
      data: {
        projectId: project.id,
        canvasNodeId,
        sourceId,
        targetId,
        label,
      },
    });
  } catch (error) {
    if (!isEdgeDedupCollision(error)) throw error;
    // The fast-path `findFirst` missed a concurrent racer that committed
    // first; the partial unique index caught it (ADR-0010). Load the racer
    // so the catch path produces the same error shape as the fast path.
    const racer = await db.edge.findFirst({
      where: { canvasNodeId, sourceId, targetId, deletedAt: null },
      select: { id: true, label: true },
    });
    throw new ConflictError(duplicateConnectionMessage(racer?.label ?? null), {
      conflictingEdgeIds: racer ? [racer.id] : [],
    });
  }
}

// Untrusted label is interpolated only into this static error string —
// never near a query or LLM prompt (prompt-injection standing note,
// CONTEXT.md).
function duplicateConnectionMessage(label: string | null): string {
  return label
    ? `That Connection already exists (labeled "${label}").`
    : "That Connection already exists.";
}

/**
 * Edits a Connection's `label`. Addressed by the Edge `id` — the natural key
 * for an existing row, and how a future MCP tool arrives: the service loads the
 * Edge, resolves its Project, and authorizes owner-only through
 * `access.assertCanWrite` (ADR-0001). Only `label` changes — `label: null`
 * clears it, `label: undefined` leaves it. There is no direction to edit: the
 * arrow is structural (output→input), derived from the endpoints (ADR-0009).
 * `label` is UNTRUSTED user content, stored verbatim (prompt-injection standing
 * note, CONTEXT.md).
 */
export async function updateEdge(
  db: Db,
  actor: Actor,
  input: UpdateEdgeInput,
): Promise<Edge> {
  const { id, label } = updateEdgeInput.parse(input);

  const edge = await db.edge.findFirst({ where: { id, deletedAt: null } });
  if (!edge) {
    throw new NotFoundError();
  }
  const project = await db.project.findFirst({
    where: { id: edge.projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  return db.edge.update({
    where: { id: edge.id },
    data: {
      ...(label !== undefined ? { label } : {}),
    },
  });
}

/**
 * Removes a Connection via soft-delete (sets `deletedAt`) so the action stays
 * recoverable — the safety net that matters because AI agents mutate the
 * graph (CONTEXT.md "Soft-delete + undo"). Addressed by the Edge `id`;
 * loaded, its Project resolved, and authorized owner-only through
 * `access.assertCanWrite` (ADR-0001). Idempotent in spirit: an
 * already-deleted Edge reads as not-found.
 *
 * Cascade behavior (Slice 2 — extends ADR-0008's "lone delete" carve-out):
 * if at least one live FlowRoute references this Edge (as `outerEdgeId` or,
 * forward-compat for Slice 3, `innerEdgeId`), the delete mints a fresh
 * `deletionId` and stamps it on BOTH the Edge and the swept FlowRoutes, so
 * `restoreEdge` can revive the batch as one unit. If no FlowRoutes are
 * incident, ADR-0008's lone-delete rule still holds — the Edge soft-deletes
 * with no `deletionId`.
 *
 * Returns the soft-deleted Edge plus the cascade metadata (`deletionId` and
 * `flowRouteIds`) so the optimistic UI can stage an undo affordance in the
 * same frame. Wrap callers in `db.$transaction` so the multi-write cascade
 * is atomic.
 */
export async function deleteEdge(
  db: Db,
  actor: Actor,
  input: DeleteEdgeInput,
): Promise<{
  edge: Edge;
  deletionId: string | null;
  flowRouteIds: string[];
}> {
  const { id } = deleteEdgeInput.parse(input);

  const edge = await db.edge.findFirst({ where: { id, deletedAt: null } });
  if (!edge) {
    throw new NotFoundError();
  }
  const project = await db.project.findFirst({
    where: { id: edge.projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  // Gather incident FlowRoutes (live, by outer OR inner edge). The
  // `innerEdgeId` arm is forward-compat — Slice 2 never writes it but the
  // sweep must include it so Slice 3 needs no retrofit.
  const incidentRoutes = await db.flowRoute.findMany({
    where: {
      OR: [{ outerEdgeId: edge.id }, { innerEdgeId: edge.id }],
      deletedAt: null,
    },
    select: { id: true },
  });
  const flowRouteIds = incidentRoutes.map((r) => r.id);
  const cascading = flowRouteIds.length > 0;
  const deletedAt = new Date();

  // No incident routes: ADR-0008's lone-delete rule applies — no `deletionId`
  // minted. The dominant case stays unchanged from Slice 1.
  if (!cascading) {
    const updated = await db.edge.update({
      where: { id: edge.id },
      data: { deletedAt },
    });
    return { edge: updated, deletionId: null, flowRouteIds: [] };
  }

  // Cascade: mint one fresh id, stamp both arms. `restoreEdge` revives by
  // this handle. The cascade is no longer "lone" in ADR-0008's sense — see
  // that ADR's Status-block amendment.
  const deletionId = randomUUID();
  const updated = await db.edge.update({
    where: { id: edge.id },
    data: { deletedAt, deletionId },
  });
  await db.flowRoute.updateMany({
    where: { id: { in: flowRouteIds }, deletedAt: null },
    data: { deletedAt, deletionId },
  });
  return { edge: updated, deletionId, flowRouteIds };
}

/**
 * Undoes a cascading `deleteEdge`: restores EXACTLY the rows stamped with
 * the given `deletionId` — the Edge and every FlowRoute swept alongside it.
 * Both `deletedAt` and `deletionId` are cleared, so the batch handle is
 * consumed. An unknown / already-restored / lone-`deleteEdge` id (those mint
 * no `deletionId`) matches no rows and reads as not-found.
 *
 * Undo is a WRITE — owner-only via the stamped Edge's Project (ADR-0001 /
 * ADR-0002); a capability-URL viewer cannot undo. Pre-checks both de-dupe
 * invariants the revival must not violate — `idx_edge_dedup` on the Edge's
 * `(canvasNodeId, sourceId, targetId)` triple, and `idx_flow_route_dedup` on
 * each FlowRoute's `(outerEdgeId, flowId)` slot — and surfaces a readable
 * `ConflictError` BEFORE the updateMany so the user gets the conflicting
 * ids instead of a generic P2002.
 *
 * Runs inside the caller's transaction so the two updateMany sweeps commit
 * atomically.
 */
export async function restoreEdge(
  db: Db,
  actor: Actor,
  input: RestoreEdgeInput,
): Promise<{
  deletionId: string;
  edgeIds: string[];
  flowRouteIds: string[];
}> {
  const { deletionId } = restoreEdgeInput.parse(input);

  const edges = await db.edge.findMany({
    where: { deletionId },
    select: { id: true, projectId: true, canvasNodeId: true, sourceId: true, targetId: true },
  });
  const [firstEdge] = edges;
  if (!firstEdge) {
    throw new NotFoundError();
  }
  const project = await db.project.findFirst({
    where: { id: firstEdge.projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  const stampedRoutes = await db.flowRoute.findMany({
    where: { deletionId },
    select: { id: true, outerEdgeId: true, flowId: true },
  });

  // Pre-check the `idx_edge_dedup` invariant (ADR-0010): any active row whose
  // triple matches one we're about to revive would block the updateMany.
  // Done BEFORE the updates because Postgres aborts the transaction on
  // P2002 and we couldn't query for diagnostics from inside the catch.
  // Mirrors `restoreNode`'s pre-check shape verbatim.
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

  // Pre-check the `idx_flow_route_dedup` invariant: a stamped FlowRoute's
  // (outerEdgeId, flowId) slot may now be occupied by a fresh route. Same
  // posture as the Edge pre-check above.
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

  try {
    await db.edge.updateMany({
      where: { deletionId },
      data: { deletedAt: null, deletionId: null },
    });
  } catch (error) {
    if (!isEdgeDedupCollision(error)) throw error;
    throw new ConflictError(
      "Undo blocked by a concurrent write — retry to see what conflicts.",
      { conflictingEdgeIds: [] },
    );
  }

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
    edgeIds: edges.map((e) => e.id),
    flowRouteIds: stampedRoutes.map((r) => r.id),
  };
}
