import { randomUUID } from "node:crypto";

import {
  type Edge,
  type Node,
  type NodeKind as PrismaNodeKind,
  type Prisma,
} from "../../../generated/prisma/client";
import { assertCanWrite } from "./access";
import type { Actor, Db } from "./actor";
import { ConflictError, NotFoundError } from "./errors";
import { isEdgeDedupCollision, isFlowDedupCollision } from "./prisma-errors";
import {
  createNodeInput,
  deleteNodeInput,
  getCanvasInput,
  restoreNodeInput,
  updateNodeInput,
  updatePositionsInput,
  type CreateNodeInput,
  type DeleteNodeInput,
  type GetCanvasInput,
  type NodeKind,
  type RestoreNodeInput,
  type UpdateNodeInput,
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
  SERVICE: "SERVICE",
  DATABASE: "DATABASE",
  EXTERNAL_API: "EXTERNAL_API",
  HOST: "HOST",
  QUEUE: "QUEUE",
};
const _prismaKindIsZodKind: Record<PrismaNodeKind, NodeKind> = {
  GENERIC: "GENERIC",
  SERVICE: "SERVICE",
  DATABASE: "DATABASE",
  EXTERNAL_API: "EXTERNAL_API",
  HOST: "HOST",
  QUEUE: "QUEUE",
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

export async function getCanvas(
  db: Db,
  _actor: Actor | null,
  input: GetCanvasInput,
): Promise<{
  interiorNodes: CanvasInteriorNode[];
  interiorEdges: Edge[];
  breadcrumbs: { id: string; title: string }[];
}> {
  const { slug, canvasNodeId } = getCanvasInput.parse(input);

  const project = await db.project.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true },
  });
  if (!project) {
    throw new NotFoundError();
  }

  const [interiorNodes, interiorEdges, breadcrumbs] = await Promise.all([
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
    // The breadcrumb trail walks `parentId` from the scope up to the root in one
    // recursive CTE (ADR-0006). At the root scope there are no ancestors, so we
    // skip the query entirely. `depth < 256` is cycle defense for a future
    // `move`/reparent feature (the graph is a tree today), not a nesting limit.
    canvasNodeId === null
      ? Promise.resolve<{ id: string; title: string }[]>([])
      : db.$queryRaw<{ id: string; title: string }[]>`
          WITH RECURSIVE ancestry AS (
            SELECT n.id, n.title, n."parentId", 0 AS depth
            FROM "Node" n
            WHERE n.id = ${canvasNodeId}
              AND n."projectId" = ${project.id}
              AND n."deletedAt" IS NULL
            UNION ALL
            SELECT p.id, p.title, p."parentId", a.depth + 1
            FROM "Node" p
            JOIN ancestry a ON p.id = a."parentId"
            WHERE p."projectId" = ${project.id}
              AND p."deletedAt" IS NULL
              AND a.depth < 256
          )
          SELECT id, title FROM ancestry ORDER BY depth DESC`,
  ]);

  // A non-null scope with no breadcrumbs never resolved to a live Node in this
  // Project. Key off the breadcrumb trail (a live scope always returns its own
  // row at depth 0), never the interior count — an empty interior is a valid
  // leaf Canvas. The root scope is exempt: it has no Component to resolve.
  if (canvasNodeId !== null && breadcrumbs.length === 0) {
    throw new NotFoundError();
  }

  return { interiorNodes, interiorEdges, breadcrumbs };
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
  // No depth cap — the graph is acyclic (no move/reparent yet; move will own
  // cycle prevention per the glossary), so the recursion terminates naturally.
  // Completeness beats a cap: a truncated cascade would silently orphan a
  // descendant under a deleted ancestor, violating ADR-0008. If runaway recursion
  // ever becomes a risk (move lands), the fail-loud guard below will catch any
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

  // Post-stamp guard (ADR-0008): the sequential cascade always gathers every live
  // descendant, so a live child still sitting directly under the freshly-stamped
  // set means a concurrent createNode raced us between the subtree read and this
  // commit. Fail loud rather than leave a silent, unrecoverable orphan.
  await assertNoOrphanedChildren(db, nodeIds);

  return { deletionId, nodeIds, edgeIds, flowIds, flowSpecIds };
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

  return {
    deletionId,
    nodeIds: nodes.map((n) => n.id),
    edgeIds: edges.map((e) => e.id),
    flowIds: stampedFlows.map((f) => f.id),
    flowSpecIds: stampedFlowSpecs.map((s) => s.id),
  };
}
