import {
  type Edge,
  type EdgeDirection as PrismaEdgeDirection,
} from "../../../generated/prisma/client";
import { assertCanWrite } from "./access";
import type { Actor, Db } from "./actor";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import {
  connectNodesInput,
  deleteEdgeInput,
  updateEdgeInput,
  type ConnectNodesInput,
  type DeleteEdgeInput,
  type EdgeDirection,
  type UpdateEdgeInput,
} from "~/lib/schemas";

// Compile-time parity guard: the client-safe Zod `edgeDirection` enum
// (~/lib/schemas) and the Prisma `EdgeDirection` enum must describe the same
// value set. If either side gains or loses a member, one of these typed maps
// stops type-checking and `pnpm check` fails — turning "keep the two enums in
// sync" from a remembered discipline into a checked invariant (CONTEXT.md "Edge
// direction"). This guard lives server-side precisely because importing the
// Prisma enum is the leak we forbid in client code (ADR-0004); the client only
// ever sees the Zod enum.
const _zodDirectionIsPrismaDirection: Record<
  EdgeDirection,
  PrismaEdgeDirection
> = {
  NONE: "NONE",
  FORWARD: "FORWARD",
  BIDIRECTIONAL: "BIDIRECTIONAL",
};
const _prismaDirectionIsZodDirection: Record<
  PrismaEdgeDirection,
  EdgeDirection
> = {
  NONE: "NONE",
  FORWARD: "FORWARD",
  BIDIRECTIONAL: "BIDIRECTIONAL",
};
void _zodDirectionIsPrismaDirection;
void _prismaDirectionIsZodDirection;

/**
 * Draws a Connection (creates an Edge) between two Components on one Canvas.
 *
 * The Canvas is the EXPLICIT `canvasNodeId` (null => the Project root) — it is
 * supplied, never inferred from the endpoints, so a future refinement
 * Connection can span scope levels without a model change (ADR-0005). Three
 * invariants are enforced here in the service, not by database constraints:
 *
 * 1. no self-Connection (`sourceId !== targetId`);
 * 2. same-Canvas — both endpoints' `parentId` equals `canvasNodeId`;
 * 3. no duplicate ACTIVE Edge sharing source + target + scope (A→B is distinct
 *    from B→A; label/direction never factor in; a soft-deleted Edge never
 *    blocks re-creation).
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
  const { projectId, canvasNodeId, sourceId, targetId, label, direction } =
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
    select: { id: true },
  });
  if (duplicate) {
    throw new ConflictError("That Connection already exists.");
  }

  return db.edge.create({
    data: {
      projectId: project.id,
      canvasNodeId,
      sourceId,
      targetId,
      label,
      direction,
    },
  });
}

/**
 * Edits a Connection's `label` and/or `direction`. Addressed by the Edge `id` —
 * the natural key for an existing row, and how a future MCP tool arrives: the
 * service loads the Edge, resolves its Project, and authorizes owner-only
 * through `access.assertCanWrite` (ADR-0001). Only the provided fields change —
 * `label: null` clears it, `label: undefined` leaves it, an omitted `direction`
 * is untouched. `label` is UNTRUSTED user content, stored verbatim
 * (prompt-injection standing note, CONTEXT.md).
 */
export async function updateEdge(
  db: Db,
  actor: Actor,
  input: UpdateEdgeInput,
): Promise<Edge> {
  const { id, label, direction } = updateEdgeInput.parse(input);

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
      ...(direction !== undefined ? { direction } : {}),
    },
  });
}

/**
 * Removes a Connection via soft-delete (sets `deletedAt`) so the action stays
 * recoverable — the safety net that matters because AI agents mutate the graph
 * (CONTEXT.md "Soft-delete + undo"). Addressed by the Edge `id`; loaded, its
 * Project resolved, and authorized owner-only through `access.assertCanWrite`
 * (ADR-0001). Idempotent in spirit: an already-deleted Edge reads as not-found.
 */
export async function deleteEdge(
  db: Db,
  actor: Actor,
  input: DeleteEdgeInput,
): Promise<Edge> {
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

  return db.edge.update({
    where: { id: edge.id },
    data: { deletedAt: new Date() },
  });
}
