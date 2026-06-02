import {
  type Edge,
  type Interaction,
  type Prisma,
} from "../../../generated/prisma/client";
import { assertCanWrite } from "./access";
import type { Actor, Db } from "./actor";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { isEdgeDedupCollision } from "./prisma-errors";
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
 * The active-duplicate predicate for a Connection's de-dupe slot. An
 * `ASSOCIATION` de-dupes on the UNORDERED endpoint pair (A↔B and B↔A are one
 * Association — `idx_edge_assoc_dedup`); a directional interaction de-dupes on
 * the ORDERED `(sourceId, targetId, interaction)` tuple (`idx_edge_dedup`), so
 * A→B REQUEST, A→B PUSH, and B→A REQUEST are three distinct Connections
 * (ADR-0027/0028, ADR-0010). The service `findFirst` MUST mirror the index it
 * is backstopping, or it falsely rejects a legitimate reverse-direction edge.
 */
export function activeDuplicateWhere(
  projectId: string,
  sourceId: string,
  targetId: string,
  interaction: Interaction,
): Prisma.EdgeWhereInput {
  if (interaction === "ASSOCIATION") {
    return {
      projectId,
      deletedAt: null,
      interaction: "ASSOCIATION",
      OR: [
        { sourceId, targetId },
        { sourceId: targetId, targetId: sourceId },
      ],
    };
  }
  return { projectId, deletedAt: null, interaction, sourceId, targetId };
}

/**
 * Draws a Connection (creates an Edge) between two Components — at any scope.
 *
 * A Connection is a directed, typed edge that may link any two Components,
 * same-Canvas, cross-scope, or lineal (an ancestor and a descendant; a
 * parent→child Connection expresses ingress; ADR-0028). It stores NO scope —
 * scope is derived from endpoint ancestry at read time (#63). The only endpoint
 * the service rejects is the true self-link (`sourceId === targetId`).
 *
 * The Connection carries its own `interaction` (default `ASSOCIATION`; ADR-0027).
 * De-dupe is enforced here in the service, with the two partial unique indexes
 * (`idx_edge_dedup` directional, `idx_edge_assoc_dedup` association) as a TOCTOU
 * backstop (ADR-0010), both surfaced as the same `ConflictError` shape
 * (`details.conflictingEdgeIds` names the active Edge that blocked the write).
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
  const { projectId, sourceId, targetId, interaction, label } =
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
  // same set-membership posture `updatePositions` uses for batch writes. Their
  // scopes (`parentId`) are NOT constrained: cross-scope and lineal endpoints
  // are accepted (ADR-0028).
  const endpoints = await db.node.findMany({
    where: {
      id: { in: [sourceId, targetId] },
      projectId: project.id,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (endpoints.length !== 2) {
    throw new NotFoundError();
  }

  const duplicateWhere = activeDuplicateWhere(
    project.id,
    sourceId,
    targetId,
    interaction,
  );
  const duplicate = await db.edge.findFirst({
    where: duplicateWhere,
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
        sourceId,
        targetId,
        interaction,
        label,
      },
    });
  } catch (error) {
    if (!isEdgeDedupCollision(error)) throw error;
    // The fast-path `findFirst` missed a concurrent racer that committed
    // first; a partial unique index caught it (ADR-0010). Re-read the racer in
    // the same slot so the catch path produces the same error shape.
    const racer = await db.edge.findFirst({
      where: duplicateWhere,
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
 * clears it, `label: undefined` leaves it. A Connection's `interaction` is set
 * at creation and (until the #65 picker) is not edited here. `label` is
 * UNTRUSTED user content, stored verbatim (prompt-injection standing note).
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
 * recoverable — the safety net that matters because AI agents mutate the graph
 * (CONTEXT.md "Soft-delete + undo"). Addressed by the Edge `id`; loaded, its
 * Project resolved, and authorized owner-only through `access.assertCanWrite`
 * (ADR-0001). Idempotent in spirit: an already-deleted Edge reads as not-found.
 *
 * `deleteEdge` is a plain LONE soft-delete (ADR-0008's carve-out, now the only
 * path): it sets `deletedAt` on the one Edge and mints NO `deletionId` — there
 * is no FlowRoute cascade to group (the Flow model is retired; ADR-0030).
 */
export async function deleteEdge(
  db: Db,
  actor: Actor,
  input: DeleteEdgeInput,
): Promise<{ edge: Edge }> {
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

  const updated = await db.edge.update({
    where: { id: edge.id },
    data: { deletedAt: new Date() },
  });
  return { edge: updated };
}

/**
 * Undoes a cascading `deleteNode` Edge sweep: restores EXACTLY the Edges stamped
 * with the given `deletionId`. Both `deletedAt` and `deletionId` are cleared, so
 * the batch handle is consumed. An unknown / already-restored / lone-`deleteEdge`
 * id (those mint no `deletionId`) matches no rows and reads as not-found.
 *
 * Undo is a WRITE — owner-only via the stamped Edge's Project (ADR-0001 /
 * ADR-0002); a capability-URL viewer cannot undo. Pre-checks the de-dupe
 * invariant the revival must not violate — for each revived Edge, its
 * interaction-appropriate slot (`idx_edge_dedup` directional or
 * `idx_edge_assoc_dedup` association) — and surfaces a readable `ConflictError`
 * BEFORE the updateMany so the user gets the conflicting ids instead of a
 * generic P2002. Runs inside the caller's transaction.
 */
export async function restoreEdge(
  db: Db,
  actor: Actor,
  input: RestoreEdgeInput,
): Promise<{
  deletionId: string;
  edgeIds: string[];
}> {
  const { deletionId } = restoreEdgeInput.parse(input);

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

  // Pre-check the de-dupe invariant (ADR-0010): any active row occupying a slot
  // we're about to revive would block the updateMany. Each revived Edge
  // contributes its interaction-appropriate predicate (association → unordered
  // pair; directional → ordered triple + interaction). Done BEFORE the update
  // because Postgres aborts the transaction on P2002 and we couldn't query for
  // diagnostics from inside the catch. Mirrors `restoreNode`'s pre-check shape.
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

  return {
    deletionId,
    edgeIds: edges.map((e) => e.id),
  };
}
