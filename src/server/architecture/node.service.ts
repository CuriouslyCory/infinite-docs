import { randomUUID } from "node:crypto";

import {
  type Edge,
  type Node,
  type NodeKind as PrismaNodeKind,
} from "../../../generated/prisma/client";
import { assertCanWrite } from "./access";
import { activeDuplicateWhere } from "./edge.service";
import type { Actor, Db } from "./actor";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { isEdgeDedupCollision } from "./prisma-errors";
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
 * Materializes a Canvas for a scope in a single round trip (ADR-0001): its
 * interior Components and the Connections among them, plus the breadcrumb trail.
 * Addressed by the capability `slug` (the read grant, ADR-0002), so it works
 * without a session.
 *
 * `interiorNodes` are the Nodes whose `parentId` is the scope. `interiorEdges`
 * are the Edges with BOTH endpoints on this Canvas — a single relation-filtered
 * query (`source.parentId === scope AND target.parentId === scope`), since an
 * Edge no longer stores its scope (ADR-0028). A cross-scope Edge (endpoints on
 * different Canvases) appears in NEITHER Canvas's interior set here; rendering it
 * at the right altitude — the redefined boundary proxy — is #63. This slice
 * renders only same-Canvas Connections, as plain lines.
 *
 * `breadcrumbs` is the ordered ancestor chain (root → current scope, included)
 * computed in a SINGLE recursive CTE, never a per-level walk (ADR-0006). The
 * root scope (`canvasNodeId === null`) has no ancestors and returns `[]`. A
 * non-null scope that resolves to no live Node in this Project (missing /
 * soft-deleted / cross-project) is a not-found — detected by an empty breadcrumb
 * trail, NOT by an empty interior (an empty interior is a legitimate leaf
 * Component).
 *
 * NOTE: the breadcrumb query is raw SQL. Postgres folds unquoted identifiers to
 * lowercase, so every model/column name is double-quoted PascalCase; the scope
 * id and project id are bound parameters, never string-interpolated (ADR-0006).
 *
 * Slug-readable (ADR-0002): the capability slug IS the read grant, so `actor` is
 * not consulted — it is accepted only to match the readable-procedure signature
 * shape (`db, actor, input`). The slug→project bind below is the gate.
 */
export async function getCanvas(
  db: Db,
  _actor: Actor | null,
  input: GetCanvasInput,
): Promise<{
  interiorNodes: Node[];
  interiorEdges: Edge[];
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

  // The three reads run in one `Promise.all` — no waterfall, no dependency on
  // `interiorNodes` resolving first. `interiorEdges` filters on the endpoints'
  // `parentId` via a relation filter (both endpoints on this scope), so it
  // needs no stored scope and no interior-id set computed first (ADR-0001).
  const [interiorNodes, interiorEdges, breadcrumbs] = await Promise.all([
    db.node.findMany({
      where: { projectId: project.id, parentId: canvasNodeId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    }),
    db.edge.findMany({
      where: {
        projectId: project.id,
        deletedAt: null,
        source: { parentId: canvasNodeId, deletedAt: null },
        target: { parentId: canvasNodeId, deletedAt: null },
      },
      orderBy: { createdAt: "asc" },
    }),
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
  ]);

  // A walk that reached the depth ceiling returns a silently-truncated trail.
  // Surface it as a typed error rather than handing back a quietly-incomplete
  // Canvas — see `ANCESTRY_DEPTH_CAP`. The recursive CTE emits depths 0..CAP, so
  // a full walk is CAP + 1 rows; anything beyond means the ceiling clipped it.
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
 * Changes a Component's `kind`. Same load-then-authorize shape as `updateNode`
 * (find the live Node, resolve its Project, authorize owner-only via
 * `access.assertCanWrite`; ADR-0001) — a separate narrow mutation so the kind
 * palette commits only `{ id, kind }`. Ownership comes from the actor, never
 * `input`.
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
 * subtree (every Node descending through `parentId` — including any spec-derived
 * child Components, which are ordinary children), every incident or interior
 * Connection, and the owned Spec are flagged `deletedAt` in ONE atomic
 * operation, all stamped with one fresh `deletionId` so the whole set can be
 * undone as a unit (`restoreNode`; ADR-0008 + ADR-0030). The safety net that
 * matters because AI agents mutate the graph (CONTEXT.md "Soft-delete + undo").
 *
 * Addressed by the Node `id`; loaded, its Project resolved, and authorized
 * owner-only through `access.assertCanWrite` BEFORE the subtree is gathered
 * (ADR-0001) — an intruder learns nothing about the graph's shape. Idempotent in
 * spirit: an already-deleted Component reads as not-found (like `deleteEdge`).
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
 * Undo is a WRITE — owner-only. The Project is resolved from the stamped rows
 * (never from input), then authorized through `access.assertCanWrite`
 * (ADR-0001/0002); a capability-URL viewer cannot undo. An unknown or
 * already-restored `deletionId` matches no rows and reads as not-found.
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
