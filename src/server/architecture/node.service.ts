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
export async function getCanvas(
  db: Db,
  _actor: Actor | null,
  input: GetCanvasInput,
): Promise<{
  interiorNodes: Node[];
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
