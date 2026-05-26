import {
  type Edge,
  type Node,
  type NodeKind as PrismaNodeKind,
} from "../../../generated/prisma/client";
import { assertCanWrite } from "./access";
import type { Actor, Db } from "./actor";
import { NotFoundError } from "./errors";
import {
  createNodeInput,
  getCanvasInput,
  updateNodeInput,
  updatePositionsInput,
  type CreateNodeInput,
  type GetCanvasInput,
  type NodeKind,
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
 * containing Component. `kind` is cosmetic (icon/color only — CONTEXT.md
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
 * Nodes and Edges are independent, so they are fetched concurrently — one
 * round-trip's depth, no waterfall (the perf model, PRD). The result is named
 * in Node/Edge terms even though users see "the interior Components and
 * Connections" (the Component/Node + Connection/Edge split). `boundaryProxies`
 * and `breadcrumbs` join this payload with boundary derivation (M3) and Descent.
 */
export async function getCanvas(
  db: Db,
  _actor: Actor | null,
  input: GetCanvasInput,
): Promise<{ interiorNodes: Node[]; interiorEdges: Edge[] }> {
  const { slug, canvasNodeId } = getCanvasInput.parse(input);

  const project = await db.project.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true },
  });
  if (!project) {
    throw new NotFoundError();
  }

  const [interiorNodes, interiorEdges] = await Promise.all([
    db.node.findMany({
      where: { projectId: project.id, parentId: canvasNodeId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    }),
    db.edge.findMany({
      where: { projectId: project.id, canvasNodeId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  return { interiorNodes, interiorEdges };
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
