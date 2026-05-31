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
 * The expiry choices the Connect-an-agent mint flow offers, in days. `null`
 * means a non-expiring token — an allowed owner choice that carries a standing
 * security exposure (warned in the UI; recorded in ADR-0020). The service
 * computes `expiresAt` from this; a raw date is never accepted, which sidesteps
 * past-date and clock-skew classes entirely.
 */
export const apiTokenExpiresInDays = z
  .union([z.literal(30), z.literal(90), z.literal(365), z.null()])
  .default(90);

/**
 * Input for minting an API token (`createApiToken`). `input` carries no userId —
 * ownership comes only from the actor (ADR-0001). `label` is an OPTIONAL,
 * UNTRUSTED display name the owner picks to tell tokens apart in the list;
 * stored verbatim. `scopes` are NOT an input here: every token is minted with a
 * single fixed read scope today (stored, not enforced — ADR-0001/ADR-0021), so a
 * picker for unenforced scopes would imply choices that change nothing (memory:
 * prefer narrow required inputs).
 */
export const createApiTokenInput = z.object({
  label: z.string().trim().min(1).max(100).optional(),
  expiresInDays: apiTokenExpiresInDays,
});
// `z.input` so callers may omit the defaulted `expiresInDays`; the service
// re-parses to materialize the default.
export type CreateApiTokenInput = z.input<typeof createApiTokenInput>;

/**
 * Input for revoking an API token. Addressed by the token `id`; the service
 * loads it scoped to the actor (a foreign id is reported not-found, never
 * forbidden — no existence disclosure, ADR-0002) and soft-stamps `revokedAt`.
 */
export const revokeApiTokenInput = z.object({
  id: z.string().min(1),
});
export type RevokeApiTokenInput = z.infer<typeof revokeApiTokenInput>;

/**
 * The Component kinds. This Zod enum is the client-safe source of truth for
 * the value set (the kind palette imports `nodeKind.options` as values); the
 * Prisma `NodeKind` enum mirrors it, and a compile-time parity guard in the
 * service layer fails the build if the two ever drift. Kind is cosmetic — it
 * drives only icon/color and the kind-affinity picker ranking (see CONTEXT.md
 * "Component kind", "Kind affinity"; ADR-0018, ADR-0019). New kinds are an
 * additive change. Never import the Prisma enum into client code (it reaches
 * the server graph); import this.
 */
export const nodeKind = z.enum([
  "GENERIC",
  "GLOBAL_INFRA",
  "REGION",
  "DATACENTER",
  "NETWORK",
  "HOST",
  "CONTAINER",
  "SERVICE",
  "MICROSERVICE",
  "CRON",
  "QUEUE",
  "APPLICATION",
  "MODULE",
  "CLASS",
  "FUNCTION",
  "VARIABLE",
  "BRANCH",
  "DATABASE",
  "TABLE",
  "STORED_PROCEDURE",
  "EXTERNAL_API",
  "ENDPOINT",
  "WEBHOOK",
  "TOPIC",
  "CONSUMER",
  "PRODUCER",
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
 * verbatim (prompt-injection standing note, CONTEXT.md). Title only — editing
 * `documentation` is its own narrow mutation (`updateNodeDocumentationInput`),
 * and editing `kind` is its own narrow mutation (`updateNodeKindInput`).
 */
export const updateNodeInput = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200),
});
export type UpdateNodeInput = z.infer<typeof updateNodeInput>;

/**
 * Input for changing a Component's `kind`. A dedicated narrow mutation (not an
 * optional field on `updateNodeInput`) so the kind palette commits only
 * `{ id, kind }`, mirroring the granular-mutation convention (`updateNode` /
 * `updateNodeDocumentation`). Addressed by the Node `id`; the service loads it,
 * resolves its Project, and enforces owner-only access (ADR-0001). Kind is
 * cosmetic — this changes only icon/color/affinity ranking, never behaviour
 * (CONTEXT.md "Component kind"; ADR-0018). Any `kind` is accepted regardless of
 * the parent's kind — affinity ranks the picker, it does not constrain the write
 * (ADR-0019).
 */
export const updateNodeKindInput = z.object({
  id: z.string().min(1),
  kind: nodeKind,
});
export type UpdateNodeKindInput = z.infer<typeof updateNodeKindInput>;

// The bounded-payload cap on `Node.documentation` — pasted/typed markdown bytes.
// Sized to be far past any practical Component doc (~100 KB is roughly 30k words)
// while bounding the autosave payload. UTF-8 bytes, mirroring
// `MAX_FLOW_SPEC_SOURCE_BYTES`'s precedent — a `string().max()` counts UTF-16
// code units, which under-counts emoji and CJK by 2×; the byte refine below
// gives a predictable wire-size budget regardless of script.
export const MAX_NODE_DOCUMENTATION_BYTES = 100_000;

/**
 * Input for editing a Component's markdown `documentation`. A dedicated narrow
 * mutation (not an optional field on `updateNodeInput`) so the canvas autosave
 * sends only `{ id, documentation }` on every debounced keystroke and rename
 * keeps its own required-`title` contract (the codebase's granular-mutation
 * convention — cf. `updateNode` / `updatePositions`). Addressed by the Node
 * `id`; the service resolves the Project and enforces owner-only access
 * (ADR-0001). `documentation` is UNTRUSTED user content, stored verbatim, never
 * interpolated (prompt-injection standing note, CONTEXT.md). Empty string is
 * allowed (clears the docs); the cap bounds the autosave payload.
 */
export const updateNodeDocumentationInput = z.object({
  id: z.string().min(1),
  // `string().max()` counts UTF-16 code units; the cap is named `_BYTES` and
  // measured in UTF-8 bytes, so refine to UTF-8 bytes here too — same pattern
  // as `attachFlowSpecInput.source` below.
  documentation: z
    .string()
    .refine(
      (s) => new TextEncoder().encode(s).length <= MAX_NODE_DOCUMENTATION_BYTES,
      { message: "Documentation exceeds the 100 KB cap." },
    ),
});
export type UpdateNodeDocumentationInput = z.infer<
  typeof updateNodeDocumentationInput
>;

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
 * How a Flow's owner Component participates in the interaction — the
 * owner-relative encoder from which a Connection's arrowheads are DERIVED
 * (never a stored direction on the Edge; ADR-0023, superseding ADR-0009/0013):
 *
 *   REQUEST   — owner is called in request/response (REST, RPC) → arrow at owner
 *   PUSH      — owner emits unprompted (SSE, webhook out, event) → arrow away
 *   SUBSCRIBE — owner consumes an external stream/feed → arrow at owner
 *   DUPLEX    — owner both sends and receives (WebSocket) → arrows both ends
 *
 * Client-safe source of truth for the value set; the Prisma `FlowInteraction`
 * enum mirrors it, kept in lockstep by a compile-time parity guard. The arrow
 * rule itself lives in `~/lib/flow-direction`. See CONTEXT.md "Interaction".
 */
export const flowInteraction = z.enum([
  "REQUEST",
  "PUSH",
  "SUBSCRIBE",
  "DUPLEX",
]);
export type FlowInteraction = z.infer<typeof flowInteraction>;

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
  // `string().max()` counts UTF-16 code units; the cap is named `_BYTES` and
  // is also re-enforced inside the parser by UTF-8 byte count, so refine to
  // UTF-8 bytes here too.
  source: z
    .string()
    .min(1)
    .refine(
      (s) => new TextEncoder().encode(s).length <= MAX_FLOW_SPEC_SOURCE_BYTES,
      { message: "Spec source exceeds the 1 MB cap." },
    ),
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
  interaction: flowInteraction,
});
export type AddFlowInput = z.input<typeof addFlowInput>;

/**
 * Input for editing a Flow's `title` (the displayable label), `interaction`
 * (the verb that drives its arrow direction), or `signature` (the structured
 * payload). Addressed by Flow `id`; the service authorizes against the Project
 * owner. Spec-derived Flows (`sourceSpecId != null`) REJECT edits — the spec is
 * the source of truth (re-paste the spec to change them). `interaction` is
 * editable so an owner can correct a parser default or refine a hand-authored
 * Flow (e.g. mark a channel DUPLEX); `key`/`kind` stay non-editable until a real
 * need surfaces (memory: "prefer narrow required inputs"). `title` is UNTRUSTED.
 */
export const updateFlowInput = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(200).optional(),
  interaction: flowInteraction.optional(),
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

/**
 * Input for paging a boundary proxy's Flow palette (Slice 3 / #36). `getCanvas`
 * bundles the first page of each in-scope proxy's palette; the inspector pages
 * the remainder through this procedure when an owner exposes more Flows than
 * the bundle carries. Addressed by `ownerNodeId` + `slug` (slug-readable per
 * ADR-0002, like `getFlowsForNode`); `cursor` is the last Flow id from the
 * previous page (omit for the first page).
 */
export const getFlowPaletteInput = z.object({
  ownerNodeId: z.string().min(1),
  slug: z.string().min(1),
  cursor: z.string().min(1).optional(),
});
export type GetFlowPaletteInput = z.infer<typeof getFlowPaletteInput>;

/**
 * Input for routing a Flow onto a Connection (creating a FlowRoute). Addressed
 * by `flowId` and `outerEdgeId`; the service loads both, asserts they share a
 * Project, authorizes owner-only against that Project (ADR-0001), and rejects
 * unless the Flow's owner is one endpoint of the outer Edge. The polarity-
 * vs-arrow refinement of that rule is Slice 4's invariant — not enforced
 * here. The de-dupe rule `(outerEdgeId, flowId)` follows the ADR-0010 named
 * pattern with the `idx_flow_route_dedup` partial unique index as the TOCTOU
 * backstop.
 *
 * Two shapes, discriminated by whether `sourceNodeId` / `targetNodeId` are
 * present:
 *
 * - **Same-Canvas baseline** (both absent): "this pipe carries this Flow."
 *   Creates a FlowRoute with `innerEdgeId = null`. The Slice-2 path, unchanged.
 * - **Cross-scope refinement** (both present): "this Flow, one scope deeper,
 *   continues as the interior Connection between the interior Component and
 *   the boundary proxy." `sourceNodeId` / `targetNodeId` are the inner Edge's
 *   endpoints exactly as the UI synthesizes them (direction-blind here —
 *   polarity is Slice 4). Exactly one of them must be the **boundary
 *   endpoint** (the Flow's owner, which is an endpoint of the outer Edge); the
 *   other is the **interior endpoint** that must sit on the interior Canvas of
 *   the outer Edge's other endpoint. The service find-or-creates the inner
 *   Edge — the sole gated exception to ADR-0005's same-Canvas rule (ADR-0012).
 *
 * Both-or-neither: supplying just one endpoint is rejected — the inner Edge
 * needs both, and a half-specified route would be ambiguous (memory: "prefer
 * narrow required inputs"). `innerEdgeId` is never an input — the service
 * derives it, so a client can never name a cross-scope Edge directly.
 */
export const routeFlowInput = z
  .object({
    flowId: z.string().min(1),
    outerEdgeId: z.string().min(1),
    sourceNodeId: z.string().min(1).optional(),
    targetNodeId: z.string().min(1).optional(),
  })
  .refine(
    (v) => (v.sourceNodeId === undefined) === (v.targetNodeId === undefined),
    {
      message:
        "Cross-scope refinement routing needs both the interior Component and the boundary endpoint (sourceNodeId + targetNodeId), or neither for same-Canvas routing.",
      // Cross-field rule, not a single-field error: attach at the object root.
      path: [],
    },
  );
export type RouteFlowInput = z.infer<typeof routeFlowInput>;

/**
 * Input for removing a FlowRoute. Addressed by FlowRoute `id`; the service
 * authorizes against the Project owner. Removal is a soft-delete (sets
 * `deletedAt`) so re-routing the same (flowId, outerEdgeId) pair later still
 * works — the `idx_flow_route_dedup` partial index excludes deletedAt rows
 * (ADR-0010 precondition c). A lone `unrouteFlow` does NOT mint a
 * `deletionId` — that handle ties cascading-batch deletes only (ADR-0008).
 */
export const unrouteFlowInput = z.object({
  flowRouteId: z.string().min(1),
});
export type UnrouteFlowInput = z.infer<typeof unrouteFlowInput>;

/**
 * Input for undoing a cascading `deleteEdge`. Addressed by the `deletionId`
 * minted by `deleteEdge` when it swept at least one incident FlowRoute (the
 * lone-Edge case still mints no id; see ADR-0014, the cascade decision).
 * The service restores EXACTLY the rows bearing that id — the Edge and its
 * swept FlowRoutes — and pre-checks the `idx_edge_dedup` and
 * `idx_flow_route_dedup` invariants so a conflicting active row surfaces a
 * readable error rather than a P2002. Owner-only; never slug-granted
 * (ADR-0002).
 */
export const restoreEdgeInput = z.object({
  deletionId: z.string().min(1),
});
export type RestoreEdgeInput = z.infer<typeof restoreEdgeInput>;

/**
 * Input for reading the active FlowRoute flowIds on a Connection — drives the
 * "+ flow" popover's unrouted filter (Slice 2). Read access is via the
 * capability slug (ADR-0002), so the panel works in shared-view mode too.
 * Returns just `flowId`s — the popover already has the endpoint Flow lists
 * via `getFlowsForNode`; this query only answers "which of those are
 * already routed?" Smallest helper that fits.
 */
export const getRoutedFlowIdsForEdgeInput = z.object({
  outerEdgeId: z.string().min(1),
  slug: z.string().min(1),
});
export type GetRoutedFlowIdsForEdgeInput = z.infer<
  typeof getRoutedFlowIdsForEdgeInput
>;

/**
 * Input for deterministic markdown export (M2 / #15). Addressed by the
 * capability `slug` (the read grant, ADR-0002), so it works without a session —
 * the same posture `getCanvas` uses. `canvasNodeId` selects what to export:
 * `null` = the whole Project (no Boundary section — the root has no
 * ancestors); a Node id = the subtree rooted at that Component (Boundary
 * section enumerates the externals incident to the subtree root on its parent
 * Canvas, so the export is self-describing). `mode` picks the rendering:
 * `"full"` includes authored Component documentation (heading-shifted via AST,
 * never regex; ADR-0017); `"index"` omits doc bodies and renders a cheap
 * structural map (titles, kinds, anchors, per-Component Connection counts) for
 * navigation / agent indexing. Both modes are byte-stable across runs and
 * locales (the determinism contract — ADR-0017).
 */
export const exportMarkdownMode = z.enum(["full", "index"]);
export type ExportMarkdownMode = z.infer<typeof exportMarkdownMode>;

export const exportMarkdownInput = z.object({
  slug: z.string().min(1),
  canvasNodeId: z.string().nullable().default(null),
  mode: exportMarkdownMode.default("full"),
});
export type ExportMarkdownInput = z.input<typeof exportMarkdownInput>;

/**
 * Input for the owner-gated MCP read path (#18). The same three serializer
 * modes as {@link exportMarkdownInput}, but addressed by the internal
 * `projectId` rather than the capability `slug`: the MCP path resolves an Actor
 * from a bearer token and authorizes by ownership (`assertCanRead`), so the slug
 * — a parallel bearer grant — must never be the key here (ADR-0002, ADR-0021).
 * `projectId` is required and narrow: the agent dereferences a resource URI the
 * server minted, never a user id (no resource accepts one).
 */
export const mcpReadInput = z.object({
  projectId: z.string().min(1),
  canvasNodeId: z.string().nullable().default(null),
  mode: exportMarkdownMode.default("full"),
});
export type McpReadInput = z.input<typeof mcpReadInput>;
