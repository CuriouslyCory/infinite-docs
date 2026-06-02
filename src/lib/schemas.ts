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
 * A Connection's type, carried on its Edge as `interaction` (ADR-0027). Five
 * values: a default undirected `ASSOCIATION` plus four directional interactions
 * describing, relative to the `source` endpoint, how it participates — the verb
 * from which a Connection's arrowheads are DERIVED together with draw order
 * (rendering lands in #65, never a stored arrow):
 *
 *   ASSOCIATION — a plain undirected relationship; no arrowheads (the default)
 *   REQUEST     — source is called in request/response → arrow at target
 *   PUSH        — source emits unprompted (SSE, webhook out) → arrow at target
 *   SUBSCRIBE   — source consumes an external stream/feed → arrow at source
 *   DUPLEX      — source both sends and receives (WebSocket) → arrows both ends
 *
 * Client-safe source of truth for the value set; the Prisma `Interaction` enum
 * mirrors it. Renamed from `FlowInteraction` and gained `ASSOCIATION` with the
 * Flow model's retirement (#62). See CONTEXT.md "Interaction".
 */
export const interaction = z.enum([
  "ASSOCIATION",
  "REQUEST",
  "PUSH",
  "SUBSCRIBE",
  "DUPLEX",
]);
export type Interaction = z.infer<typeof interaction>;

/**
 * A Spec's source format — selects which parser materializes derived child
 * Components from its `source` (#64 / ADR-0029). Client-safe source of truth
 * for the value set (the attach-spec picker imports `specKind.options`); the
 * Prisma `SpecKind` enum mirrors it, kept in lockstep by a compile-time parity
 * guard in the parser registry. Today only `OPENAPI` and `SQL_DDL` have a
 * parser; the rest are reserved (parsing them yields a `parseError`). `CUSTOM`
 * is hand-authored prose with no parser. See CONTEXT.md "Spec"; ADR-0025.
 */
export const specKind = z.enum([
  "OPENAPI",
  "ASYNCAPI",
  "TS_SIGNATURE",
  "GRAPHQL",
  "SQL_DDL",
  "CUSTOM",
]);
export type SpecKind = z.infer<typeof specKind>;

/**
 * A permissive recursive JSON value — the shape Prisma's `Json` columns accept.
 * Used to validate the `metadata` blob a Component may carry (parser-derived
 * facts that don't warrant their own column: an Endpoint's HTTP method, a
 * column's SQL type, a request-body schema kept shallow rather than exploded
 * into child Components). UNTRUSTED when it originates from a pasted Spec —
 * stored verbatim, never interpreted (prompt-injection standing note).
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

/**
 * A Component's `metadata` — always a keyed object (never a bare scalar/null),
 * so it maps cleanly to a Prisma `Json` write without the `JsonNull` vs DB-null
 * ambiguity. Object values may be any {@link jsonValue}.
 */
export const componentMetadata = z.record(z.string(), jsonValue);
export type ComponentMetadata = z.infer<typeof componentMetadata>;

// The bounded-payload cap on `Node.documentation` — pasted/typed markdown bytes.
// Sized to be far past any practical Component doc (~100 KB is roughly 30k words)
// while bounding the autosave payload. UTF-8 bytes — a `string().max()` counts
// UTF-16 code units, which under-counts emoji and CJK by 2×; the byte refine
// gives a predictable wire-size budget regardless of script.
export const MAX_NODE_DOCUMENTATION_BYTES = 100_000;

// The single byte-capped validator for Node documentation, shared by every path
// that writes docs (node create/update) AND by the parser output (#64) so a
// preview can never accept docs that the apply write would later reject. Empty
// string is allowed (clears the docs); the cap bounds the autosave/wire payload.
export const nodeDocumentation = z
  .string()
  .refine(
    (s) => new TextEncoder().encode(s).length <= MAX_NODE_DOCUMENTATION_BYTES,
    { message: "Documentation exceeds the 100 KB cap." },
  );

/**
 * Input for creating a Component. Addressed by `projectId` (an internal handle),
 * NOT by the capability slug: writes are never granted by the slug (ADR-0002),
 * so the write path does not even accept one — the service resolves the project
 * by id and enforces owner-only access. `input` carries no ownerId; identity
 * comes only from the actor (ADR-0001). `parentId` is the Canvas scope (null =>
 * the Project's root Canvas).
 *
 * `documentation` / `metadata` / `sourceSpecId` / `specKey` are optional
 * provenance carriers for Spec-driven generation (#64 / ADR-0029): the ordinary
 * canvas create path omits all four (a blank, user-placed Component); the spec
 * applier sets them so a generated Component records the Spec it came from
 * (`sourceSpecId`), the parser's stable identity for it (`specKey`), and its
 * seeded docs/metadata. "Generated" is a provenance modifier on a real `kind`,
 * never a distinct type. All are UNTRUSTED, stored verbatim (prompt-injection).
 */
export const createNodeInput = z.object({
  projectId: z.string().min(1),
  parentId: z.string().nullable().default(null),
  kind: nodeKind.default("GENERIC"),
  title: z.string().min(1).max(200).default("Untitled"),
  posX: z.number().finite().default(0),
  posY: z.number().finite().default(0),
  documentation: nodeDocumentation.optional(),
  metadata: componentMetadata.optional(),
  sourceSpecId: z.string().min(1).optional(),
  specKey: z.string().min(1).max(512).optional(),
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
 * Input for the project-wide Component list that powers the "Connect to…" search
 * (#66). Addressed by the capability `slug` (the read grant, ADR-0002) — a flat,
 * scope-independent read of every live Component, deliberately distinct from the
 * scope-keyed `getCanvasInput` (different cardinality; ADR-0032).
 */
export const listProjectComponentsInput = z.object({
  slug: z.string().min(1),
});
export type ListProjectComponentsInput = z.infer<
  typeof listProjectComponentsInput
>;

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
  documentation: nodeDocumentation,
});
export type UpdateNodeDocumentationInput = z.infer<
  typeof updateNodeDocumentationInput
>;

/**
 * Input for reparenting a Component (`moveNode`). Addressed by the Node `id`
 * — the natural key for an existing row, and how the MCP `move_component` tool
 * arrives. The service loads the Node, resolves its Project, and enforces
 * owner-only access (ADR-0001).
 *
 * `parentId` is the new Canvas scope: `null` moves the Component to the
 * Project root; a Node id reparents it under that Component's interior Canvas.
 * Required, not defaulted — a move call must state intent (memory: prefer
 * narrow required inputs). The service rejects cycle-creating moves with
 * `ValidationError`; there is no orphan-reject (incident Connections may span
 * scopes — ADR-0028, retiring ADR-0024's orphan reject).
 */
export const moveNodeInput = z.object({
  id: z.string().min(1),
  parentId: z.string().min(1).nullable(),
});
export type MoveNodeInput = z.infer<typeof moveNodeInput>;

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
 * (ADR-0001). A Connection may link any two Components at any scope —
 * same-Canvas, cross-scope, or lineal (ADR-0028); the service rejects only the
 * true self-link. There is no `canvasNodeId`: an Edge stores no scope (#63
 * derives it from endpoint ancestry). `sourceId`/`targetId` are the endpoint
 * Nodes in draw order; arrowheads are derived from `(interaction, source,
 * target)` at render time (#65), never stored. `interaction` is the Connection's
 * type (default `ASSOCIATION` — a plain undirected line; ADR-0027). `label` is
 * UNTRUSTED user content, stored verbatim (prompt-injection standing note).
 */
export const connectNodesInput = z.object({
  projectId: z.string().min(1),
  sourceId: z.string().min(1),
  targetId: z.string().min(1),
  interaction: interaction.default("ASSOCIATION"),
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
 * leaves it). A label edit can never collide (label is in no de-dupe key), so
 * this path stays a plain update; the Connection's `interaction` is edited via
 * its own surface (`updateEdgeInteraction`) because changing it CAN collide with
 * the directional de-dupe key (ADR-0027). `label` is UNTRUSTED user content,
 * stored verbatim (prompt-injection standing note, CONTEXT.md).
 */
export const updateEdgeInput = z.object({
  id: z.string().min(1),
  label: z.string().max(200).nullable().optional(),
});
export type UpdateEdgeInput = z.infer<typeof updateEdgeInput>;

/**
 * Input for upgrading a Connection's `interaction` (the picker on the selected
 * edge; #65). Addressed by the Edge `id`; the service loads the Edge, resolves
 * its Project, enforces owner-only access (ADR-0001), and — because `interaction`
 * is in the directional de-dupe key — re-checks the de-dupe slot, returning a
 * `ConflictError` if the target `(source, target, interaction)` (or the unordered
 * ASSOCIATION pair) already has an active row. `interaction` is REQUIRED: the
 * picker always names the value it is setting. Draw order (`sourceId`/`targetId`)
 * is never rewritten, so upgrading to a directional interaction points the arrow
 * the way the Connection was drawn (ADR-0027).
 */
export const updateEdgeInteractionInput = z.object({
  id: z.string().min(1),
  interaction,
});
export type UpdateEdgeInteractionInput = z.infer<
  typeof updateEdgeInteractionInput
>;

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
 * Input for the per-Component connection list shown in the Component-detail
 * panel's Connections section (#66). Addressed by the capability `slug` (the
 * read grant, ADR-0002) plus the Component's `nodeId`. Node-keyed and COMPLETE
 * across scopes — it returns every active Connection incident to the Component,
 * not just the ones visible on the current Canvas (ADR-0032), so it is distinct
 * from both `getCanvasInput` (scope-keyed) and `deleteEdgeInput` (edge-keyed).
 */
export const listNodeConnectionsInput = z.object({
  slug: z.string().min(1),
  nodeId: z.string().min(1),
});
export type ListNodeConnectionsInput = z.infer<typeof listNodeConnectionsInput>;

/**
 * Input for undoing a cascading `deleteNode` Edge sweep. Addressed by the
 * `deletionId` minted by `deleteNode` (a lone `deleteEdge` mints none — ADR-0030).
 * The service restores EXACTLY the Edges bearing that id and pre-checks the two
 * Edge de-dupe indexes so a conflicting active row surfaces a readable error
 * rather than a P2002. Owner-only; never slug-granted (ADR-0002).
 */
export const restoreEdgeInput = z.object({
  deletionId: z.string().min(1),
});
export type RestoreEdgeInput = z.infer<typeof restoreEdgeInput>;

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

/**
 * A reference to a Node inside an `apply_graph` batch — either an existing
 * server-minted id (already in the DB) or a `clientId` the agent picked for a
 * sibling Component in this same batch. Tagged-union discriminator, NOT a
 * prefix sigil ("@n1" loses static narrowing and bakes the encoding into the
 * wire format) and NOT heuristic ("treat anything in the clientIds set as a
 * client ref" silently rebinds when a real server id happens to share that
 * string). See ADR-0026 for the shape decision, CONTEXT.md "Client id" for the
 * glossary entry.
 */
export const applyGraphNodeRef = z.discriminatedUnion("ref", [
  z.object({ ref: z.literal("server"), id: z.string().min(1) }),
  z.object({ ref: z.literal("client"), clientId: z.string().min(1).max(64) }),
]);
export type ApplyGraphNodeRef = z.infer<typeof applyGraphNodeRef>;

/**
 * One Component arm of an `apply_graph` batch. Mirrors {@link createNodeInput}
 * minus `projectId` (lifted to the top of the batch) and with `parentId`
 * replaced by a {@link applyGraphNodeRef} — so a Component can name its parent
 * by either a server id or a sibling `clientId` from this same call. The
 * `clientId` is the agent-chosen handle other batch entries reference; it must
 * be unique across the whole batch (enforced in {@link applyGraphInput}'s
 * `superRefine`). `title` is UNTRUSTED user content, stored verbatim
 * (prompt-injection standing note, CONTEXT.md). See ADR-0026.
 */
export const applyGraphComponentInput = z.object({
  clientId: z.string().min(1).max(64),
  parent: applyGraphNodeRef.nullable().default(null),
  kind: nodeKind.default("GENERIC"),
  title: z.string().min(1).max(200).default("Untitled"),
  posX: z.number().finite().default(0),
  posY: z.number().finite().default(0),
});
// `z.input` (not `z.infer`) so callers may omit the defaulted fields; the
// service re-parses with the schema to materialize the defaults.
export type ApplyGraphComponentInput = z.input<typeof applyGraphComponentInput>;

/**
 * One Connection arm of an `apply_graph` batch. Mirrors
 * {@link connectNodesInput} minus `projectId` (lifted to the top), with
 * `source` / `target` replaced by {@link applyGraphNodeRef} so each endpoint can
 * be a server id or a sibling `clientId`. A Connection may span scopes
 * (ADR-0028), so there is no `canvasNode` ref. `interaction` is the Connection's
 * type (default `ASSOCIATION`; ADR-0027). No `clientId` on Connections — nothing
 * references a Connection by client id (memory: prefer narrow required inputs).
 * `label` is UNTRUSTED user content, stored verbatim. See ADR-0026.
 */
export const applyGraphConnectionInput = z.object({
  source: applyGraphNodeRef,
  target: applyGraphNodeRef,
  interaction: interaction.default("ASSOCIATION"),
  label: z.string().max(200).optional(),
});
// `z.input` (not `z.infer`) so callers may omit the defaulted fields.
export type ApplyGraphConnectionInput = z.input<
  typeof applyGraphConnectionInput
>;

/**
 * Top-level input for the `apply_graph` MCP batch tool. Discriminated
 * top-level arrays (`components: []`, `connections: []`), not a flat
 * `entities: []` — any future arm joins as its own typed array without
 * renumbering, and discriminated arrays keep the wire shape statically
 * narrowable per arm. Per-arm length caps bound the transaction-holding time
 * the batch can monopolize (philosophy #1 — keep the app feeling fast even
 * when one agent ships a huge batch).
 *
 * The `superRefine` enforces batch-wide `clientId` uniqueness across the
 * `components` array so the flat `idMap` shape stays collision-free. Connections
 * do not carry a `clientId` today, so the check is component-only here; any
 * future arm that carries clientIds extends the same `seen` map. See ADR-0026
 * for the shape decisions; CONTEXT.md "Client id" for the glossary entry.
 */
export const applyGraphInput = z
  .object({
    projectId: z.string().min(1),
    components: z.array(applyGraphComponentInput).max(500).default([]),
    connections: z.array(applyGraphConnectionInput).max(1000).default([]),
  })
  .superRefine((value, ctx) => {
    const seen = new Map<string, number>();
    for (const [i, c] of value.components.entries()) {
      if (seen.has(c.clientId)) {
        ctx.addIssue({
          code: "custom",
          path: ["components", i, "clientId"],
          message: `Duplicate clientId "${c.clientId}" (also at components[${seen.get(c.clientId)}]).`,
        });
      }
      seen.set(c.clientId, i);
    }
  });
// `z.input` (not `z.infer`) so callers may omit defaulted fields; the service
// re-parses with the schema to materialize them.
export type ApplyGraphInput = z.input<typeof applyGraphInput>;

/**
 * Typed output of the `apply_graph` MCP batch tool. Drives MCP's `outputSchema`
 * (SDK 1.26.0) so the agent receives `structuredContent` on the wire — not a
 * JSON-encoded message blob it has to re-parse. `idMap` is keyed by the
 * `clientId` strings the agent picked for each Component and maps to the
 * server-minted Node ids it should pass to subsequent tool calls. See ADR-0026.
 */
export const applyGraphOutput = z.object({
  idMap: z.record(z.string(), z.string()),
  componentCount: z.number().int().nonnegative(),
  connectionCount: z.number().int().nonnegative(),
});
export type ApplyGraphOutput = z.infer<typeof applyGraphOutput>;

// ---------------------------------------------------------------------------
// Spec → Component generation (#64 / ADR-0029)
// ---------------------------------------------------------------------------

/**
 * The bounded-payload cap on a pasted Spec's `source`. A Spec is UNTRUSTED
 * user-pasted text that the server then *parses* — so it must hit a size bound
 * before the parser ever walks it (the parse-time-trust standing note,
 * CONTEXT.md; ADR-0008's bounded-loader rule). UTF-8 bytes, generous enough for
 * a large OpenAPI document but far short of an OOM lever.
 */
export const MAX_SPEC_SOURCE_BYTES = 2_000_000;

const specSource = z
  .string()
  .refine((s) => new TextEncoder().encode(s).length <= MAX_SPEC_SOURCE_BYTES, {
    message: "Spec source exceeds the 2 MB cap.",
  });

/**
 * One node of a parser's recursive output (#64 / ADR-0029). A parser turns a
 * pasted Spec into a tree of these; the applier turns each into an ordinary
 * child Component (its `kind` is real — GENERIC only when the parser cannot
 * infer one). Fields:
 *  - `specKey` — the parser's STABLE per-format identity for this node, UNIQUE
 *    across the whole parsed tree (child keys are qualified by their parent's,
 *    e.g. `GET /pets#query:limit`). It is what the diff matches on, so a
 *    re-parse re-identifies the same Component and preserves its Node id,
 *    position, and incident Connections (ADR-0029).
 *  - `documentation` — an optional seed for the Component's docs on first
 *    create; thereafter user-owned (a re-parse never silently overwrites it —
 *    only an explicit "overwrite + wipe docs" does).
 *  - `metadata` — parser-derived facts kept shallow rather than exploded into
 *    deeper children (HTTP method/path, a column's SQL type, a request-body
 *    schema). UNTRUSTED, stored verbatim.
 * Typed by hand (not `z.infer`) because Zod cannot infer the recursive `self`.
 */
export interface ParsedComponent {
  specKey: string;
  kind: NodeKind;
  title: string;
  documentation?: string;
  metadata?: ComponentMetadata;
  children?: ParsedComponent[];
}
export const parsedComponent: z.ZodType<ParsedComponent> = z.lazy(() =>
  z.object({
    specKey: z.string().min(1).max(512),
    kind: nodeKind,
    title: z.string().min(1).max(200),
    documentation: nodeDocumentation.optional(),
    metadata: componentMetadata.optional(),
    children: z.array(parsedComponent).optional(),
  }),
);

/**
 * Input for the read-only preview that powers the attach/merge UX (#64). The
 * service parses `source` with the `kind`'s parser and diffs the result against
 * the owner Component's existing generated children — WITHOUT writing anything
 * (cancel = zero writes is the whole point). Addressed by `ownerNodeId` (the
 * Component the Spec attaches to); the service resolves the Project and enforces
 * owner-only access (ADR-0001). `source` is UNTRUSTED, bounded, never
 * interpolated.
 */
export const previewSpecInput = z.object({
  ownerNodeId: z.string().min(1),
  kind: specKind,
  source: specSource,
});
export type PreviewSpecInput = z.infer<typeof previewSpecInput>;

/**
 * A user's resolution for one CHANGED Component (matched by `specKey` but with
 * differing derived fields) in the conflict modal. `overwrite` refreshes the
 * derived fields (title, kind, metadata); `wipeDocumentation` additionally
 * clears the now-stale docs (default keeps them — docs are user-owned). `skip`
 * leaves the Component untouched. Position and incident Connections are NEVER in
 * this prompt — always preserved (ADR-0029).
 */
export const specChangedResolution = z.object({
  specKey: z.string().min(1).max(512),
  action: z.enum(["skip", "overwrite"]),
  wipeDocumentation: z.boolean().default(false),
});
export type SpecChangedResolution = z.infer<typeof specChangedResolution>;

/**
 * A user's resolution for one DROPPED Component (present in the graph, gone from
 * the re-parsed Spec). `keep` detaches it from the Spec (`sourceSpecId → null`),
 * retaining the now-user-owned Component with its docs and Connections;
 * `delete` soft-deletes its subtree and incident Connections (ADR-0008). Keyed
 * by `nodeId` (an existing Node), not `specKey`.
 */
export const specDroppedResolution = z.object({
  nodeId: z.string().min(1),
  action: z.enum(["keep", "delete"]),
});
export type SpecDroppedResolution = z.infer<typeof specDroppedResolution>;

/**
 * Input for applying a previewed Spec (#64). The server RE-PARSES `source` and
 * RE-DIFFS server-side (never trusts a client-sent tree — the source is
 * untrusted), then applies the user's per-item resolutions in one transaction:
 * NEW Components are always created; CHANGED follow `changed[]` (default skip —
 * a key absent here is left as-is); DROPPED follow `dropped[]` (default keep — a
 * nodeId absent here is detached, never deleted: destructive actions are never
 * the default). First attach (no existing Spec, all-new) needs neither array.
 * Owner-only; the caller wraps it in a transaction so a partial apply rolls back.
 */
export const applySpecInput = z.object({
  ownerNodeId: z.string().min(1),
  kind: specKind,
  source: specSource,
  changed: z.array(specChangedResolution).max(5000).default([]),
  dropped: z.array(specDroppedResolution).max(5000).default([]),
});
export type ApplySpecInput = z.input<typeof applySpecInput>;
