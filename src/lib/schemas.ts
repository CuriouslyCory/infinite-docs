import { z } from "zod";

/**
 * Zod input schemas for the architecture service layer.
 *
 * Lives in `~/lib` (not `~/server`) and imports only `zod`, so client forms
 * can import these as VALUES for shared validation without pulling the server
 * module graph into the browser bundle. The service layer re-validates with
 * the same schemas at its boundary, so this module is the single source of
 * truth for input shape on both sides. See docs/adr/0004.
 */

export const createProjectInput = z.object({
  title: z.string().min(1).max(200),
});
export type CreateProjectInput = z.infer<typeof createProjectInput>;

export const getProjectBySlugInput = z.object({
  slug: z.string().min(1),
});
export type GetProjectBySlugInput = z.infer<typeof getProjectBySlugInput>;

/**
 * The six Component kinds. This Zod enum is the client-safe source of truth for
 * the value set (the kind picker imports `nodeKind.options` as values); the
 * Prisma `NodeKind` enum mirrors it, and a compile-time parity guard in the
 * service layer fails the build if the two ever drift. Kind is cosmetic — it
 * drives only icon/color (see CONTEXT.md "Component kind"). Never import the
 * Prisma enum into client code (it reaches the server graph); import this.
 */
export const nodeKind = z.enum([
  "GENERIC",
  "SERVICE",
  "DATABASE",
  "EXTERNAL_API",
  "HOST",
  "QUEUE",
]);
export type NodeKind = z.infer<typeof nodeKind>;

/**
 * Input for creating a Component. Addressed by `projectId` (an internal handle),
 * NOT by the capability slug: writes are never granted by the slug (ADR-0002),
 * so the write path does not even accept one — the service resolves the project
 * by id and enforces owner-only access. `input` carries no ownerId; identity
 * comes only from the actor (ADR-0001). `parentId` is the Canvas scope (null =>
 * the Project's root Canvas).
 */
export const createNodeInput = z.object({
  projectId: z.string().min(1),
  parentId: z.string().nullable().default(null),
  kind: nodeKind.default("GENERIC"),
  title: z.string().min(1).max(200).default("Untitled"),
  posX: z.number().finite().default(0),
  posY: z.number().finite().default(0),
});
// `z.input` (not `z.infer`/`z.output`) so callers may omit the defaulted fields;
// the service re-parses with the schema to materialize the defaults.
export type CreateNodeInput = z.input<typeof createNodeInput>;

/**
 * Input for reading a Canvas. Addressed by the capability `slug` (the read grant,
 * ADR-0002), so it works without a session. `canvasNodeId` is the Canvas scope:
 * null reads the Project's root Canvas, a Node id reads that Component's interior
 * Canvas (interior scopes land with Descent in a later slice).
 */
export const getCanvasInput = z.object({
  slug: z.string().min(1),
  canvasNodeId: z.string().nullable().default(null),
});
export type GetCanvasInput = z.input<typeof getCanvasInput>;

/**
 * Input for renaming a Component (updating a Node's `title`). Addressed by the
 * Node `id` — the natural key for an existing row — NOT by a projectId: the
 * service loads the Node, resolves its Project, and enforces owner-only access
 * (ADR-0001), which is also how a future MCP "rename" tool arrives (it holds a
 * node id, not a project handle). `title` is UNTRUSTED user content, stored
 * verbatim (prompt-injection standing note, CONTEXT.md). Title only for now;
 * editing `kind`/`documentation` is an additive change in a later milestone.
 */
export const updateNodeInput = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
});
export type UpdateNodeInput = z.infer<typeof updateNodeInput>;

/**
 * Input for the batch position write committed on drag-stop. Addressed by
 * `projectId` (an internal handle, never the capability slug — writes are never
 * slug-granted, ADR-0002): the service authorizes the whole batch once against
 * the Project owner, then confirms every position's `id` belongs to that
 * Project before writing, so a foreign Node id can never be moved. Batch by
 * design — a React Flow multi-select drag moves N Components in one gesture, and
 * the perf model commits exactly one mutation on drag-stop, never one per Node
 * (CONTEXT.md / PRD).
 */
export const updatePositionsInput = z.object({
  projectId: z.string().min(1),
  positions: z
    .array(
      z.object({
        id: z.string().min(1),
        posX: z.number().finite(),
        posY: z.number().finite(),
      }),
    )
    .min(1),
});
export type UpdatePositionsInput = z.infer<typeof updatePositionsInput>;

/**
 * The three Connection orientations. This Zod enum is the client-safe source of
 * truth for the value set (the edge renderer imports it as values); the Prisma
 * `EdgeDirection` enum mirrors it, and a compile-time parity guard in
 * edge.service fails the build if the two ever drift. Direction is cosmetic —
 * it drives only how a Connection is drawn (no arrowhead / one / two) and never
 * factors into de-duplication (see CONTEXT.md "Edge direction"). Never import
 * the Prisma enum into client code (it reaches the server graph); import this.
 */
export const edgeDirection = z.enum(["NONE", "FORWARD", "BIDIRECTIONAL"]);
export type EdgeDirection = z.infer<typeof edgeDirection>;

/**
 * Input for drawing a Connection (creating an Edge). Addressed by `projectId`
 * (an internal handle), NOT the capability slug: writes are never slug-granted
 * (ADR-0002). `input` carries no ownerId; identity comes only from the actor
 * (ADR-0001). `canvasNodeId` is the Canvas the Connection is painted on (null =>
 * the Project root) and is supplied explicitly, never inferred from the
 * endpoints (ADR-0005); the service confirms both endpoints actually sit on it.
 * `sourceId`/`targetId` are the endpoint Nodes. `label` is UNTRUSTED user
 * content, stored verbatim (prompt-injection standing note, CONTEXT.md).
 */
export const connectNodesInput = z.object({
  projectId: z.string().min(1),
  canvasNodeId: z.string().nullable().default(null),
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  label: z.string().max(200).optional(),
  direction: edgeDirection.default("FORWARD"),
});
// `z.input` (not `z.infer`) so callers may omit the defaulted fields; the
// service re-parses with the schema to materialize them.
export type ConnectNodesInput = z.input<typeof connectNodesInput>;

/**
 * Input for editing a Connection (its `label` and/or `direction`). Addressed by
 * the Edge `id` — the natural key for an existing row, and how a future MCP tool
 * arrives. The service loads the Edge, resolves its Project, and enforces
 * owner-only access (ADR-0001). `label` is nullable (null clears it) and
 * optional (undefined leaves it); `direction` is optional. `label` is UNTRUSTED
 * user content, stored verbatim (prompt-injection standing note, CONTEXT.md).
 */
export const updateEdgeInput = z.object({
  id: z.string().min(1),
  label: z.string().max(200).nullable().optional(),
  direction: edgeDirection.optional(),
});
export type UpdateEdgeInput = z.infer<typeof updateEdgeInput>;

/**
 * Input for removing a Connection. Addressed by the Edge `id`; the service
 * loads it, resolves its Project, and enforces owner-only access (ADR-0001).
 * Removal is a soft-delete (sets `deletedAt`) so the action stays recoverable.
 */
export const deleteEdgeInput = z.object({
  id: z.string().min(1),
});
export type DeleteEdgeInput = z.infer<typeof deleteEdgeInput>;
