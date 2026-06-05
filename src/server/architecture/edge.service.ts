import {
  type Edge,
  type Interaction,
  type Prisma,
} from "../../../generated/prisma/client";
import {
  authorizeProjectWrite,
  resolveReadableProject,
  resolveReadableProjectById,
} from "./access-db";
import type { Actor, Db } from "./actor";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { isEdgeDedupCollision } from "./prisma-errors";
import {
  connectCrossProjectInput,
  connectNodesInput,
  deleteEdgeInput,
  listNodeConnectionsInput,
  restoreEdgeInput,
  updateEdgeInput,
  updateEdgeInteractionInput,
  type ConnectCrossProjectInput,
  type ConnectNodesInput,
  type DeleteEdgeInput,
  type ListNodeConnectionsInput,
  type NodeKind,
  type RestoreEdgeInput,
  type UpdateEdgeInput,
  type UpdateEdgeInteractionInput,
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
 * Requires `edit` capability — owner, ADMIN, or EDITOR member (ADR-0040). The
 * Project is addressed by `projectId` (an internal handle, never the capability
 * slug — writes are never slug-granted, ADR-0002) and the write is authorized
 * through `access-db.authorizeProjectWrite(…, "edit")`. The actor identity comes
 * from the session, never from `input` (ADR-0001). `label` is UNTRUSTED user
 * content, stored verbatim (prompt-injection standing note).
 */
export async function connectNodes(
  db: Db,
  actor: Actor,
  input: ConnectNodesInput,
): Promise<Edge> {
  const { projectId, sourceId, targetId, interaction, label } =
    connectNodesInput.parse(input);

  const project = await authorizeProjectWrite(db, actor, projectId, "edit");

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

/**
 * The non-disclosing shape `connectCrossProject` returns: the persisted
 * `CrossProjectEdge` row WITHOUT `foreignProjectId` (the internal foreign
 * `Project.id`) or the unwired `deletionId`. `foreignProjectId` is the one column
 * that must never cross the wire (the slice's headline invariant); `foreignNodeId`
 * stays — it is an opaque cuid the client uses only as the proxy `realEndpointId`.
 */
export interface CrossProjectEdgeRepr {
  id: string;
  hostProjectId: string;
  hostNodeId: string;
  referenceNodeId: string;
  foreignNodeId: string;
  interaction: Interaction;
  label: string | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Draws a CROSS-PROJECT Connection (#122): a host Component to a specific
 * Component inside an EMBEDDED Project, anchored in the host. It is NOT an `Edge`
 * — it persists a `CrossProjectEdge` row, leaving `Edge`'s dedup indexes and
 * the single-project ancestry CTE pristine — and it does NOT write into the
 * foreign Project's graph (viewed standalone, the foreign Project never shows it).
 *
 * The gate order IS the non-disclosure property — load-bearing, do not reorder:
 *
 *   1. HOST `edit` FIRST (`authorizeProjectWrite(hostProjectId, "edit")` →
 *      Forbidden on deny). The host id is a handle the caller already holds, so a
 *      Forbidden leaks nothing — and gating it first means a caller who cannot edit
 *      the host NEVER probes the foreign endpoint, so this path can never oracle a
 *      foreign Component's existence.
 *   2. Load the host endpoints (`hostNodeId`, `referenceNodeId`) scoped to the
 *      host, selecting `embeddedProjectId`. Both must be present, and the
 *      `referenceNode` must be a PORTAL (`embeddedProjectId != null`) — else
 *      NotFound. The foreign project id is DERIVED from that portal, never taken
 *      from the client (the client never holds it; #119).
 *   3. SELF / same-project reject (`foreignProjectId === host.id` →
 *      ValidationError): a cross-project edge into the host itself is degenerate.
 *   4. FOREIGN ≥ `view` (`resolveReadableProjectById(foreignProjectId)` → NotFound
 *      on deny). "You may only link to what you can read." A foreign project the
 *      actor cannot read is indistinguishable from a missing one (non-disclosure).
 *   5. Validate `foreignNodeId` is a live Node in that foreign Project (NotFound on
 *      miss) — set-membership, never disclosing existence elsewhere.
 *   6. Create the row.
 *
 * No dedup pre-check this slice — the dedup unique index + collision handling are
 * #123. `label` is UNTRUSTED user content, stored verbatim. Identity comes from the
 * actor, never `input` (ADR-0001).
 *
 * The return is the NON-DISCLOSING {@link CrossProjectEdgeRepr} — it deliberately
 * OMITS `foreignProjectId` (the internal foreign `Project.id`), upholding the
 * slice's headline invariant that the foreign project id never reaches any
 * client-facing output (`getCanvas` strips it everywhere too). The client only
 * consumes `id` (for the `xproxy_<id>` optimistic reconcile).
 */
export async function connectCrossProject(
  db: Db,
  actor: Actor,
  input: ConnectCrossProjectInput,
): Promise<CrossProjectEdgeRepr> {
  const { hostProjectId, hostNodeId, referenceNodeId, foreignNodeId, interaction, label } =
    connectCrossProjectInput.parse(input);

  // (1) Host edit gate FIRST — Forbidden on deny (the handle is already held).
  // A caller who cannot edit the host never reaches the foreign probe below.
  const host = await authorizeProjectWrite(db, actor, hostProjectId, "edit");

  // (2) Both host endpoints must be live Nodes in the host Project. Scoping to
  // `host.id` closes cross-project smuggling (a foreign node id can never be the
  // host endpoint) and never reveals existence elsewhere. The `referenceNode` must
  // be a PORTAL — its `embeddedProjectId` is the foreign Project, DERIVED here,
  // never taken from the client.
  const hostEndpoints = await db.node.findMany({
    where: {
      id: { in: [hostNodeId, referenceNodeId] },
      projectId: host.id,
      deletedAt: null,
    },
    select: { id: true, embeddedProjectId: true },
  });
  if (hostEndpoints.length !== 2) {
    throw new NotFoundError();
  }
  const referenceNode = hostEndpoints.find((n) => n.id === referenceNodeId);
  if (referenceNode?.embeddedProjectId == null) {
    throw new NotFoundError();
  }
  const foreignProjectId = referenceNode.embeddedProjectId;

  // (3) Same-project / self reject — a cross-project edge into the host itself is
  // degenerate (e.g. a portal that embeds its own host).
  if (foreignProjectId === host.id) {
    throw new ValidationError(
      "A cross-project Connection cannot link back into the host Project.",
    );
  }

  // (4) Foreign read gate — NotFound on deny (non-disclosure; "link to what you
  // can read"). Re-resolved per-actor: the host's grant never governs the foreign.
  await resolveReadableProjectById(db, actor, foreignProjectId);

  // (5) The foreign endpoint must be a live Node in that foreign Project —
  // set-membership, never disclosing whether the id exists elsewhere.
  const foreignNode = await db.node.findFirst({
    where: { id: foreignNodeId, projectId: foreignProjectId, deletedAt: null },
    select: { id: true },
  });
  if (!foreignNode) {
    throw new NotFoundError();
  }

  // (6) Create the row. No dedup pre-check / unique index this slice — that
  // (and a TOCTOU backstop) is #123. The `select` OMITS `foreignProjectId` (the
  // internal foreign Project.id) and the unwired `deletionId` so the foreign
  // project id never reaches a client-facing return (the slice's headline
  // non-disclosure invariant) — the persisted row still carries both.
  return db.crossProjectEdge.create({
    data: {
      hostProjectId: host.id,
      hostNodeId,
      referenceNodeId,
      foreignProjectId,
      foreignNodeId,
      interaction,
      label,
    },
    select: {
      id: true,
      hostProjectId: true,
      hostNodeId: true,
      referenceNodeId: true,
      foreignNodeId: true,
      interaction: true,
      label: true,
      deletedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

/**
 * One Connection as the Component-detail panel's Connections section lists it
 * (#66): the Edge's own fields, whether the listed Component is the Connection's
 * `source` (so the panel can draw the arrow relative to it without re-deriving
 * `interaction` + draw order), and the FAR endpoint resolved to its display
 * fields. `label` is UNTRUSTED user content (prompt-injection standing note).
 */
export interface NodeConnection {
  id: string;
  interaction: Interaction;
  label: string | null;
  sourceIsSelf: boolean;
  other: { id: string; title: string; kind: NodeKind };
}

/**
 * Lists every active Connection incident to one Component — COMPLETE across
 * scopes (#66 / ADR-0032). Unlike `getCanvas.interiorEdges` (the Connections
 * visible on ONE Canvas, far ends resolved to on-scope reprs / boundary
 * proxies), this is node-keyed: it returns ALL of a Component's Connections,
 * including the lineal ones to its own descendants that collapse off its home
 * Canvas. Each row carries the far endpoint's display fields so the panel needs
 * no second read; a soft-deleted far endpoint hides the row (the same posture
 * `getCanvas` takes — a Connection with a dead end is not surfaced).
 *
 * Capability-gated read on `view` via the slug→project bind (ADR-0040): the
 * default `guestAccess=VIEW` lets any slug-holder see the list read-only; a
 * `guestAccess=NONE` project is not-found for a non-member. Scoping the Edge
 * query to that `projectId` means a `nodeId` from another Project simply matches
 * nothing (no cross-project disclosure). One round trip — the far endpoints come
 * back on the same query via the Edge→Node relations, never a per-edge follow-up.
 */
export async function listNodeConnections(
  db: Db,
  actor: Actor | null,
  input: ListNodeConnectionsInput,
): Promise<NodeConnection[]> {
  const { slug, nodeId } = listNodeConnectionsInput.parse(input);

  const project = await resolveReadableProject(db, actor, slug);

  const edges = await db.edge.findMany({
    where: {
      projectId: project.id,
      deletedAt: null,
      OR: [{ sourceId: nodeId }, { targetId: nodeId }],
    },
    select: {
      id: true,
      sourceId: true,
      interaction: true,
      label: true,
      source: {
        select: { id: true, title: true, kind: true, deletedAt: true },
      },
      target: {
        select: { id: true, title: true, kind: true, deletedAt: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const connections: NodeConnection[] = [];
  for (const edge of edges) {
    const sourceIsSelf = edge.sourceId === nodeId;
    // The end that isn't the listed Component. A self-link can't exist
    // (`connectNodes` rejects `sourceId === targetId`), so the far end is always
    // the opposite relation.
    const far = sourceIsSelf ? edge.target : edge.source;
    // A soft-deleted far endpoint hides the Connection — the same posture
    // `getCanvas` takes when an endpoint is dead.
    if (far.deletedAt !== null) continue;
    connections.push({
      id: edge.id,
      interaction: edge.interaction,
      label: edge.label,
      sourceIsSelf,
      other: { id: far.id, title: far.title, kind: far.kind },
    });
  }
  return connections;
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
 * Edge, resolves its Project, and authorizes via
 * `authorizeProjectWrite(…, "edit")` — `edit` capability: owner, ADMIN, or EDITOR
 * member (ADR-0040). Only `label` changes — `label: null`
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
  await authorizeProjectWrite(db, actor, edge.projectId, "edit");

  return db.edge.update({
    where: { id: edge.id },
    data: {
      ...(label !== undefined ? { label } : {}),
    },
  });
}

/**
 * Upgrades a Connection's `interaction` (the picker on the selected edge; #65).
 * Addressed by the Edge `id`; loaded, its Project resolved, and authorized via
 * `authorizeProjectWrite(…, "edit")` — `edit` capability: owner, ADMIN, or EDITOR
 * member (ADR-0040).
 *
 * Unlike `updateEdge` (label-only, never collides), changing `interaction` can
 * collide with the de-dupe indexes: the four directional values de-dupe on the
 * ORDERED `(projectId, sourceId, targetId, interaction)` tuple and `ASSOCIATION`
 * on the unordered pair (ADR-0010/0027), so upgrading `A↔B ASSOCIATION` to
 * `A→B REQUEST` moves the row into a different slot that another active
 * Connection may already hold. We therefore re-run the same de-dupe pre-check +
 * P2002 backstop `connectNodes` uses — with `id` excluded, since an Edge is never
 * its own duplicate — surfacing the same `ConflictError` shape. `sourceId`/
 * `targetId` are NEVER rewritten, so the arrow points the way the Connection was
 * drawn (ADR-0027). A no-op (interaction unchanged) skips the check and writes
 * nothing new.
 */
export async function updateEdgeInteraction(
  db: Db,
  actor: Actor,
  input: UpdateEdgeInteractionInput,
): Promise<Edge> {
  const { id, interaction } = updateEdgeInteractionInput.parse(input);

  const edge = await db.edge.findFirst({ where: { id, deletedAt: null } });
  if (!edge) {
    throw new NotFoundError();
  }
  await authorizeProjectWrite(db, actor, edge.projectId, "edit");

  if (edge.interaction === interaction) {
    return edge;
  }

  // Re-evaluate the de-dupe slot for the NEW interaction, excluding this Edge
  // (it is not its own duplicate — the one wrinkle `connectNodes` never needs,
  // because there the row does not exist yet).
  const duplicateWhere: Prisma.EdgeWhereInput = {
    ...activeDuplicateWhere(
      edge.projectId,
      edge.sourceId,
      edge.targetId,
      interaction,
    ),
    id: { not: edge.id },
  };
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
    return await db.edge.update({
      where: { id: edge.id },
      data: { interaction },
    });
  } catch (error) {
    if (!isEdgeDedupCollision(error)) throw error;
    // A concurrent racer committed into the target slot first; the partial
    // unique index caught it (ADR-0010). Re-read it for the same error shape.
    const racer = await db.edge.findFirst({
      where: duplicateWhere,
      select: { id: true, label: true },
    });
    throw new ConflictError(duplicateConnectionMessage(racer?.label ?? null), {
      conflictingEdgeIds: racer ? [racer.id] : [],
    });
  }
}

/**
 * Removes a Connection via soft-delete (sets `deletedAt`) so the action stays
 * recoverable — the safety net that matters because AI agents mutate the graph
 * (CONTEXT.md "Soft-delete + undo"). Addressed by the Edge `id`; loaded, its
 * Project resolved, and authorized via `authorizeProjectWrite(…, "edit")` —
 * `edit` capability: owner, ADMIN, or EDITOR member (ADR-0040). Idempotent in
 * spirit: an already-deleted Edge reads as not-found.
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
  await authorizeProjectWrite(db, actor, edge.projectId, "edit");

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
 * Undo is a WRITE — requires `edit` capability (owner, ADMIN, or EDITOR member;
 * ADR-0040) via the stamped Edge's Project (ADR-0001 / ADR-0002); a read-only
 * (guest-VIEW) viewer cannot undo. Pre-checks the de-dupe
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
  await authorizeProjectWrite(db, actor, firstEdge.projectId, "edit");

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
