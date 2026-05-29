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
 * Input for deleting a Component. Addressed by the Node `id` — the natural key
 * for an existing row, and how a future MCP "delete" tool arrives: the service
 * loads the Node, resolves its Project, and enforces owner-only access
 * (ADR-0001). Deletion is a cascading soft-delete — the Node, its subtree, and
 * every incident or interior Connection are stamped with one shared deletion id
 * so the whole operation is undoable as a unit (ADR-0008). Writes are never
 * slug-granted (ADR-0002).
 */
export const deleteNodeInput = z.object({
  id: z.string().min(1),
});
export type DeleteNodeInput = z.infer<typeof deleteNodeInput>;

/**
 * Input for undoing a cascading Component delete. Addressed by the `deletionId`
 * minted by `deleteNode` (the undo handle): the service restores EXACTLY the
 * rows bearing that id and nothing else (ADR-0008). Undo is a write — owner-only
 * (the owner is resolved from the stamped rows' Project), never slug-granted
 * (ADR-0002).
 */
export const restoreNodeInput = z.object({
  deletionId: z.string().min(1),
});
export type RestoreNodeInput = z.infer<typeof restoreNodeInput>;

/**
 * Input for drawing a Connection (creating an Edge). Addressed by `projectId`
 * (an internal handle), NOT the capability slug: writes are never slug-granted
 * (ADR-0002). `input` carries no ownerId; identity comes only from the actor
 * (ADR-0001). `canvasNodeId` is the Canvas the Connection is painted on (null =>
 * the Project root) and is supplied explicitly, never inferred from the
 * endpoints (ADR-0005); the service confirms both endpoints actually sit on it.
 * `sourceId`/`targetId` are the endpoint Nodes — their ordering (output Port →
 * input Port) IS the Connection's direction; the arrow is structural, never a
 * stored field (ADR-0009). `label` is UNTRUSTED user content, stored verbatim
 * (prompt-injection standing note, CONTEXT.md).
 */
export const connectNodesInput = z.object({
  projectId: z.string().min(1),
  canvasNodeId: z.string().nullable().default(null),
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  label: z.string().max(200).optional(),
});
// `z.input` (not `z.infer`) so callers may omit the defaulted fields; the
// service re-parses with the schema to materialize them.
export type ConnectNodesInput = z.input<typeof connectNodesInput>;

/**
 * Input for editing a Connection's `label`. Addressed by the Edge `id` — the
 * natural key for an existing row, and how a future MCP tool arrives. The
 * service loads the Edge, resolves its Project, and enforces owner-only access
 * (ADR-0001). `label` is nullable (null clears it) and optional (undefined
 * leaves it). There is no direction to edit — the arrow is structural,
 * output→input, derived from the endpoints (ADR-0009). `label` is UNTRUSTED
 * user content, stored verbatim (prompt-injection standing note, CONTEXT.md).
 */
export const updateEdgeInput = z.object({
  id: z.string().min(1),
  label: z.string().max(200).nullable().optional(),
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

/**
 * The seven Flow kinds. Client-safe source of truth for the value set; the
 * Prisma `FlowKind` enum mirrors it, and a compile-time parity guard in the
 * service layer fails the build if the two ever drift. Kind is cosmetic — it
 * drives palette icons and renderer format, never authorization or routing
 * (see CONTEXT.md "Flow kind"; ADR-0011). Never import the Prisma enum into
 * client code; import this.
 */
export const flowKind = z.enum([
  "GENERIC",
  "OPENAPI_OPERATION",
  "ASYNCAPI_CHANNEL",
  "SSE_STREAM",
  "WEBSOCKET",
  "FUNCTION_CALL",
  "EVENT",
]);
export type FlowKind = z.infer<typeof flowKind>;

/**
 * The five FlowSpec source formats. Slice 1 implements the OPENAPI parser;
 * ASYNCAPI / TS_SIGNATURE / GRAPHQL / CUSTOM persist source and record
 * `parseError` until their parsers land additively (see CONTEXT.md
 * "Flow spec kind"; ADR-0011).
 */
export const flowSpecKind = z.enum([
  "OPENAPI",
  "ASYNCAPI",
  "TS_SIGNATURE",
  "GRAPHQL",
  "CUSTOM",
]);
export type FlowSpecKind = z.infer<typeof flowSpecKind>;

/**
 * A Flow's directional relationship to its owner Component. INBOUND = owner
 * consumes; OUTBOUND = owner emits. The owner-relative encoder that lets
 * bidirectional pipes resolve to two Connections without a stored direction
 * field on the Edge (ADR-0009 reaffirmed; see CONTEXT.md "Polarity").
 */
export const flowPolarity = z.enum(["INBOUND", "OUTBOUND"]);
export type FlowPolarity = z.infer<typeof flowPolarity>;

// The bounded-loader hard cap on `FlowSpec.source` size — pasted spec bytes.
// Enforced at the Zod boundary AND re-enforced inside the parser (belt +
// suspenders); a hostile spec can OOM the parser before reaching the output
// boundary, so size is gated at parse time (CONTEXT.md prompt-injection
// standing note, parse-time clause).
export const MAX_FLOW_SPEC_SOURCE_BYTES = 1_000_000;

/**
 * Input for attaching (or re-attaching) a FlowSpec to a Component. Addressed
 * by `ownerNodeId` (the Component whose contract this spec is); the service
 * loads it, resolves its Project, and enforces owner-only access (ADR-0001).
 * `source` is UNTRUSTED user-pasted content (prompt-injection standing note,
 * CONTEXT.md) — stored verbatim, parsed only by a bounded loader. Re-attach
 * is non-destructive: matching keys preserved, dropped keys soft-deleted with
 * a fresh `deletionId` per re-parse batch (ADR-0011).
 */
export const attachFlowSpecInput = z.object({
  ownerNodeId: z.string().min(1),
  kind: flowSpecKind,
  source: z.string().min(1).max(MAX_FLOW_SPEC_SOURCE_BYTES),
});
export type AttachFlowSpecInput = z.infer<typeof attachFlowSpecInput>;

/**
 * Input for adding a user-authored Flow (no FlowSpec). Addressed by
 * `ownerNodeId`; the service authorizes against the owner Component's
 * Project. The de-dupe rule `(ownerNodeId, key)` is enforced service-primary
 * with a partial unique index backstop (ADR-0010 named pattern; ADR-0011).
 * `title` is UNTRUSTED user content, stored verbatim.
 */
export const addFlowInput = z.object({
  ownerNodeId: z.string().min(1),
  kind: flowKind.default("GENERIC"),
  key: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  polarity: flowPolarity,
});
export type AddFlowInput = z.input<typeof addFlowInput>;

/**
 * Input for editing a Flow's `title` (the displayable label) or `signature`
 * (the structured payload). Addressed by Flow `id`; the service authorizes
 * against the Project owner. Spec-derived Flows (`sourceSpecId != null`)
 * REJECT edits — the spec is the source of truth (re-paste the spec to
 * change them). `key`/`kind`/`polarity` are NOT editable in this slice
 * (memory: "prefer narrow required inputs"); add additively when a real need
 * surfaces. `title` is UNTRUSTED.
 */
export const updateFlowInput = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  signature: z.unknown().optional(),
});
export type UpdateFlowInput = z.infer<typeof updateFlowInput>;

/**
 * Input for removing a Flow. Addressed by Flow `id`; the service authorizes
 * against the Project owner. Removal is a soft-delete (sets `deletedAt`) so
 * the action stays recoverable. A lone `deleteFlow` does NOT mint a
 * `deletionId` — that handle ties cascading-batch deletes only (ADR-0008).
 */
export const deleteFlowInput = z.object({
  id: z.string().min(1),
});
export type DeleteFlowInput = z.infer<typeof deleteFlowInput>;

/**
 * Input for reading a Component's Flow palette. Addressed by `ownerNodeId`;
 * read access is owner OR valid capability slug (ADR-0002), so the panel
 * works in shared-view mode too. Returns active Flows ordered by createdAt;
 * bounded to the first 200 rows (cursor pagination is additive future work).
 */
export const getFlowsForNodeInput = z.object({
  ownerNodeId: z.string().min(1),
  slug: z.string().min(1),
});
export type GetFlowsForNodeInput = z.infer<typeof getFlowsForNodeInput>;
