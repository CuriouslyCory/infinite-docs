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

export const deleteProjectInput = z.object({
  slug: z.string().min(1),
});
export type DeleteProjectInput = z.infer<typeof deleteProjectInput>;

/**
 * Anonymous-link access level (#105). Client-safe source of truth for the value
 * set — the ShareMenu toggle imports `guestAccessLevel`/`GuestAccessLevel` as
 * values/types, exactly like the kind palette imports `nodeKind`. The Prisma
 * `GuestAccess` enum mirrors it; a compile-time parity guard in the service
 * layer (`project.service.ts`) fails the build on drift. NEVER import the Prisma
 * enum into client code — it reaches the server graph (ADR-0004); import this.
 *
 *   NONE — only the owner and invited members may read.
 *   VIEW — anyone holding the capability slug may read (the default; ADR-0002).
 */
export const guestAccessLevel = z.enum(["NONE", "VIEW"]);
export type GuestAccessLevel = z.infer<typeof guestAccessLevel>;

/**
 * Input for `setGuestAccess` (ADR-0040, ADMIN+). Addressed by `projectId` (an
 * internal handle the owner/admin already holds in the header), NOT the slug —
 * writes are never slug-granted (ADR-0002), and the id-keyed write seam can
 * surface `ForbiddenError` on deny because the caller already holds the handle.
 */
export const setGuestAccessInput = z.object({
  projectId: z.string().min(1),
  level: guestAccessLevel,
});
export type SetGuestAccessInput = z.infer<typeof setGuestAccessInput>;

/**
 * Input for `getProjectAccess` (ADR-0040, ADMIN+). Slug-keyed because the
 * ShareMenu lives on the `/p/[slug]` route where the slug is the ambient handle;
 * it reuses the non-disclosing read seam so a true non-reader stays not-found.
 * #108 extends the SAME `getProjectAccess({ slug })` for a member/invite panel,
 * so the slug is the right key going forward too.
 */
export const getProjectAccessInput = z.object({
  slug: z.string().min(1),
});
export type GetProjectAccessInput = z.infer<typeof getProjectAccessInput>;

/**
 * A Member's assignable Role (#106). Client-safe source of truth for the value
 * set — the ShareMenu invite-create role picker imports `projectRole.options`
 * as values, exactly like the kind palette imports `nodeKind`. The Prisma
 * `ProjectRole` enum mirrors it; a compile-time parity guard in the service
 * layer (`invite.service.ts`) fails the build on drift. There is no OWNER or
 * NONE member role — owner is the `ownerId` identity, "none" is the absence of a
 * grant (ADR-0040). NEVER import the Prisma enum into client code — it reaches
 * the server graph (ADR-0004); import this.
 */
export const projectRole = z.enum(["VIEWER", "EDITOR", "ADMIN"]);
export type ProjectRoleInput = z.infer<typeof projectRole>;

/**
 * Input for granting a Membership directly by a user's email (`grantMemberByEmail`,
 * #107). Addressed by `projectId` (an internal handle the manager already holds in
 * the ShareMenu), NOT the slug — writes are never slug-granted (ADR-0002). Gated
 * ADMIN+ in the service. `email` is the address to look up case-insensitively
 * (Discord supplies it on sign-in); `max(320)` is the RFC-5321 address ceiling.
 * `role` is the Role to grant — applied at MAX(existing, role), never a downgrade.
 */
export const grantMemberByEmailInput = z.object({
  projectId: z.string().min(1),
  email: z.string().email().max(320),
  role: projectRole,
});
export type GrantMemberByEmailInput = z.infer<typeof grantMemberByEmailInput>;

/**
 * Input for changing an existing member's Role (`updateMemberRole`, #108).
 * Addressed by `projectId` (the internal handle the manager already holds in the
 * ShareMenu), NOT the slug — writes are never slug-granted (ADR-0002). Gated
 * ADMIN+ in the service, which also rejects targeting the owner (the owner is the
 * `ownerId` identity, never a membership row — ADR-0040). Unlike the grant paths
 * (`claimInvite`/`grantMemberByEmail`, which apply MAX to never downgrade a
 * bearer claim), this is a DIRECT SET: an explicit admin action is authoritative,
 * so an intentional EDITOR→VIEWER downgrade is the whole point of the panel.
 */
export const updateMemberRoleInput = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1),
  role: projectRole,
});
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleInput>;

/**
 * Input for removing a member (`removeMember`, #108). Addressed by `projectId`
 * (the internal handle the manager already holds), NOT the slug — writes are
 * never slug-granted (ADR-0002). Gated ADMIN+ in the service, which rejects
 * targeting the owner (owner is identity, never a membership row — ADR-0040). An
 * admin MAY remove another admin and MAY remove themselves; only the owner is
 * untouchable. Removal deletes the membership row, so access falls back to the
 * project's guest grant (or none) on the member's next authorization pass.
 */
export const removeMemberInput = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1),
});
export type RemoveMemberInput = z.infer<typeof removeMemberInput>;

/**
 * Input for revoking an invite link (`revokeInvite`, #108). Addressed by the
 * invite `id` — the natural key for the row the manage-access panel lists. The
 * service deliberately INVERTS the usual id-keyed Forbidden posture here: an
 * inviteId is NOT a presumed-held project handle (unlike `projectId` in the other
 * mutations), so an inviteId the caller cannot administer — or one that does not
 * exist — must both map to ONE `NotFoundError`, never disclosing the invite (and
 * thus its project) to a non-admin who guessed or holds the id (ADR-0040
 * non-disclosure). Revoking blocks FUTURE claims only; memberships already
 * granted via the link are untouched.
 */
export const revokeInviteInput = z.object({
  inviteId: z.string().min(1),
});
export type RevokeInviteInput = z.infer<typeof revokeInviteInput>;

/**
 * The expiry choices the invite-create flow offers, in days. Mirrors
 * `apiTokenExpiresInDays` (a bounded day-count, never a raw date — sidesteps
 * past-date and clock-skew classes) but defaults to **7**: invites churn faster
 * than API tokens, so a short default is the safer good-default (philosophy #2).
 * `null` is a non-expiring invite — an allowed but standing exposure (warned in
 * the UI). The service computes `expiresAt` from this.
 */
export const inviteExpiresInDays = z
  .union([z.literal(7), z.literal(30), z.literal(90), z.null()])
  .default(7);

/**
 * Input for minting a role-bearing invite link (`createInvite`, #106). Addressed
 * by `projectId` (an internal handle the manager already holds in the ShareMenu),
 * NOT the slug — writes are never slug-granted (ADR-0002). Gated ADMIN+ in the
 * service. `role` is the Role the link grants on redemption; `maxUses` null =
 * unlimited (a positive int caps the redemptions, hard-bounded at 1000 so an
 * accidental huge value can't mint a near-unlimited standing link).
 */
export const createInviteInput = z.object({
  projectId: z.string().min(1),
  role: projectRole,
  expiresInDays: inviteExpiresInDays,
  maxUses: z.number().int().positive().max(1000).nullable().default(null),
});
// `z.input` so callers may omit the defaulted `expiresInDays`/`maxUses`; the
// service re-parses to materialize the defaults.
export type CreateInviteInput = z.input<typeof createInviteInput>;

/**
 * Input for redeeming an invite link (`claimInvite`, #106). Carries only the raw
 * `infinv_…` bearer token — the `/i/[token]` route shell passes it; the actor
 * comes from the session (claim is signed-in only). Every invalid state (missing
 * / expired / revoked / maxed / soft-deleted project) collapses to one
 * non-disclosing `NotFoundError` in the service (ADR-0040 redemption protocol).
 */
export const claimInviteInput = z.object({
  token: z.string().min(1),
});
export type ClaimInviteInput = z.infer<typeof claimInviteInput>;

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
  // The ordered stack of portal Node ids crossed to reach this scope (#119). `[]`
  // (the default) is the ordinary same-project read; a non-empty path walks one
  // Project Portal per id, re-gating the descending actor against each embedded
  // Project, so the read STAYS on the host's URL while rendering foreign content.
  // The chain is UNTRUSTED client state (it rides the route's `?via=`), so the
  // service re-resolves every crossing — a forged/stale id collapses to NotFound at
  // the re-gate. `max(256)` mirrors the breadcrumb depth cap (a portal can never
  // out-nest the ancestry walk it shares); the `slug`/`canvasNodeId` pair addresses
  // the ACTIVE (innermost) project once the path is walked.
  embedPath: z.array(z.string().min(1)).max(256).default([]),
});
export type GetCanvasInput = z.input<typeof getCanvasInput>;

/**
 * Input for creating a Project Portal Component (`createEmbeddedComponent`, #119).
 * Addressed by `projectId` (the HOST, an internal handle — writes are never
 * slug-granted, ADR-0002) plus `embeddedProjectId` (the TARGET to embed). The
 * service gates host `edit` FIRST (a non-disclosing write the caller already holds
 * the handle for), THEN target ≥ `view`, and rejects a self-embed
 * (`embeddedProjectId === projectId`). `parentId` is the Canvas scope the portal is
 * dropped on (null = the host's root Canvas); `posX`/`posY` are the drop point;
 * `title` is the UNTRUSTED label, stored verbatim. Identity comes from the actor,
 * never `input` (ADR-0001). A portal carries an ordinary cosmetic `kind` — its
 * behavior comes from the FK, not the kind (ADR-0018).
 */
export const createEmbeddedComponentInput = z.object({
  projectId: z.string().min(1),
  embeddedProjectId: z.string().min(1),
  parentId: z.string().nullable().default(null),
  kind: nodeKind.default("GENERIC"),
  title: z.string().min(1).max(200).default("Untitled"),
  posX: z.number().finite().default(0),
  posY: z.number().finite().default(0),
});
// `z.input` so callers may omit the defaulted fields; the service re-parses.
export type CreateEmbeddedComponentInput = z.input<
  typeof createEmbeddedComponentInput
>;

/**
 * Input for the embed-target picker (`listReferenceableProjects`, #119). Carries
 * the current `excludeProjectId` so the host never lists itself as an embed target
 * (self-embed is rejected server-side too, but excluding it keeps the picker
 * honest). Narrow + required (memory: prefer narrow required inputs).
 */
export const listReferenceableProjectsInput = z.object({
  excludeProjectId: z.string().min(1),
});
export type ListReferenceableProjectsInput = z.infer<
  typeof listReferenceableProjectsInput
>;

/**
 * Input for the cross-layer **Trace view** read (#58). Addressed by the
 * capability `slug` (the read grant, ADR-0002) plus the working-trace point set
 * `nodeIds` — the trace points live in client `localStorage` (#57), so the
 * server cannot prefetch this; the island passes them at query time. Narrow and
 * required (CONTEXT.md "prefer narrow required inputs"): `min(1)` rejects an
 * empty set at the edge, and `max(500)` bounds the input before any derivation
 * runs (defense in depth with the service-side `TRACE_NODE_CAP`). The service
 * itself filters to live, in-Project nodes and returns the empty shape below two
 * survivors — so a stale / foreign / soft-deleted id is silently dropped, never
 * an error.
 */
export const getTraceViewInput = z.object({
  slug: z.string().min(1),
  nodeIds: z.array(z.string().min(1)).min(1).max(500),
});
export type GetTraceViewInput = z.infer<typeof getTraceViewInput>;

/**
 * Inputs for the saved-**Trace** CRUD surface (#59 / ADR-0035). Every input is
 * slug-bound: reads (`list`/`get`) resolve the slug through the view-gate (a
 * `guestAccess=VIEW` project, or a member, may read — parity with `getTraceView`);
 * writes (`create`/`rename`/`delete`) carry the slug so the SERVICE resolves the
 * Project and enforces `edit` capability (owner, ADMIN, or EDITOR member) via the
 * capability ladder (ADR-0040), non-disclosing on deny — the procedure is only the
 * transport gate. Narrow + required (CONTEXT.md "prefer narrow required
 * inputs"). A Trace is "two or more trace points", so `createTraceInput.nodeIds`
 * is `min(2)`; the service further filters to live, in-Project Components and
 * rejects with a ValidationError if fewer than two survive. `max(500)` mirrors
 * `getTraceViewInput`'s cap.
 */
export const traceName = z.string().trim().min(1).max(120);

export const createTraceInput = z.object({
  slug: z.string().min(1),
  name: traceName,
  nodeIds: z.array(z.string().min(1)).min(2).max(500),
});
export type CreateTraceInput = z.infer<typeof createTraceInput>;

export const listTracesInput = z.object({ slug: z.string().min(1) });
export type ListTracesInput = z.infer<typeof listTracesInput>;

export const getTraceInput = z.object({
  slug: z.string().min(1),
  traceId: z.string().min(1),
});
export type GetTraceInput = z.infer<typeof getTraceInput>;

export const renameTraceInput = z.object({
  slug: z.string().min(1),
  traceId: z.string().min(1),
  name: traceName,
});
export type RenameTraceInput = z.infer<typeof renameTraceInput>;

export const deleteTraceInput = z.object({
  slug: z.string().min(1),
  traceId: z.string().min(1),
});
export type DeleteTraceInput = z.infer<typeof deleteTraceInput>;

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
 * Input for persisting where a boundary proxy sits on one scope's Canvas (#91 /
 * ADR-0036). Addressed by `projectId` (an internal handle, never the capability
 * slug — writes are never slug-granted, ADR-0002): the service authorizes once
 * against the Project owner, then confirms both Node ids belong to that Project
 * before writing. The natural key is `(containerNodeId, realEndpointId)`:
 *   - `containerNodeId` is the SCOPE's container Component, REQUIRED but NULLABLE —
 *     `null` is the root Canvas (its proxies sit at the root scope), not "unset".
 *   - `realEndpointId` is the off-scope Component the proxy stands in for — the
 *     stable, coalesced key (#90), NEVER the per-edge `proxy_<edgeId>` view id.
 * A single placement per call: a boundary proxy is `selectable:false`, so it can
 * never be part of a multi-select drag, so there is no batch (unlike
 * `updatePositions`). Persisting only a view coordinate keeps the proxy's identity
 * fully derived (ADR-0031).
 */
export const upsertBoundaryProxyPlacementInput = z.object({
  projectId: z.string().min(1),
  containerNodeId: z.string().min(1).nullable(),
  realEndpointId: z.string().min(1),
  posX: z.number().finite(),
  posY: z.number().finite(),
});
export type UpsertBoundaryProxyPlacementInput = z.infer<
  typeof upsertBoundaryProxyPlacementInput
>;

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

// MCP `outputSchema` (SDK 1.26.0): the agent receives `structuredContent`, not a
// message blob. `deletionId` is the undo handle for `restore_component`.
// Mirrors `deleteNode`'s return (ADR-0008, ADR-0030).
export const deleteComponentOutput = z.object({
  deletionId: z.string(),
  nodeIds: z.array(z.string()),
  edgeIds: z.array(z.string()),
  specIds: z.array(z.string()),
});
export type DeleteComponentOutput = z.infer<typeof deleteComponentOutput>;

// `restoreNode` returns the identical shape — reuse the delete output schema.
export const restoreComponentOutput = deleteComponentOutput;

// A lone `deleteEdge` mints no `deletionId` (ADR-0030) — no undo handle to surface.
export const deleteConnectionOutput = z.object({
  edgeId: z.string(),
});
export type DeleteConnectionOutput = z.infer<typeof deleteConnectionOutput>;

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
 * Input for the member-aware MCP read path (#18, member parity #109). The same
 * three serializer modes as {@link exportMarkdownInput}, but addressed by the
 * internal `projectId` rather than the capability `slug`: the MCP path resolves
 * an Actor from a bearer token and authorizes through the capability ladder
 * (owner or member, `guestAccess` forced NONE), so the slug — a parallel bearer
 * grant — must never be the key here (ADR-0002, ADR-0021, ADR-0040). `projectId`
 * is required and narrow: the agent dereferences a resource URI the server
 * minted, never a user id (no resource accepts one).
 */
export const mcpReadInput = z.object({
  projectId: z.string().min(1),
  canvasNodeId: z.string().nullable().default(null),
  mode: exportMarkdownMode.default("full"),
});
export type McpReadInput = z.input<typeof mcpReadInput>;

/**
 * Input for the member-aware MCP **trace** read resource (#60, member parity
 * #109). Addressed by the internal `traceId` only — no slug (a parallel bearer
 * grant, ADR-0002) and no user id (the Actor carries identity; ADR-0022 §3 — no
 * resource accepts a user id). The service resolves the Trace → its Project →
 * the capability ladder (owner or member, `guestAccess` forced NONE), so the key
 * here must be the internal id. Narrow and required.
 */
export const mcpTraceReadInput = z.object({ traceId: z.string().min(1) });
export type McpTraceReadInput = z.input<typeof mcpTraceReadInput>;

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
 * One Connection a parser materializes alongside its component tree (#76) — today
 * a foreign key in a SQL DDL Spec. The applier resolves `sourceKey`/`targetKey`
 * to the generated Components' Node ids and draws an Edge carrying Spec
 * provenance (ADR-0033). Fields:
 *  - `specKey` — the STABLE per-Connection identity (the FK constraint name, else
 *    a derived `sourceKey→targetKey` key), UNIQUE across the parsed connections,
 *    so a re-parse re-identifies the same Connection and reconciles it.
 *  - `sourceKey` / `targetKey` — the `specKey`s of the two endpoint Components
 *    this Connection links (the referencing and referenced tables).
 *  - `interaction` — the Connection type (REQUEST for an FK: referencing →
 *    referenced).
 *  - `label` — optional display label (the FK column(s)). UNTRUSTED, verbatim.
 */
export interface ParsedConnection {
  specKey: string;
  sourceKey: string;
  targetKey: string;
  interaction: Interaction;
  label?: string;
}
export const parsedConnection = z.object({
  specKey: z.string().min(1).max(512),
  sourceKey: z.string().min(1).max(512),
  targetKey: z.string().min(1).max(512),
  interaction,
  label: z.string().max(200).optional(),
});

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

/**
 * Typed output of the `apply_spec` MCP tool (#67). Mirrors `ApplySpecResult`
 * from `~/server/architecture/spec.service.ts` so the MCP catalog's
 * `outputSchema` (SDK 1.26.0) carries the same wire shape the service
 * returns. Drives `structuredContent` on the response — the agent reads a
 * typed object, not a JSON-encoded message blob (ADR-0026 §6 seam reused).
 */
export const applySpecOutput = z.object({
  specId: z.string().min(1),
  ownerNodeId: z.string().min(1),
  created: z.number().int().nonnegative(),
  overwritten: z.number().int().nonnegative(),
  detached: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  // FK Connections auto-reconciled this apply (#76): drawn (incl. adopted) and
  // soft-deleted because their FK vanished from the spec.
  connectionsCreated: z.number().int().nonnegative(),
  connectionsRemoved: z.number().int().nonnegative(),
});
export type ApplySpecOutput = z.infer<typeof applySpecOutput>;
