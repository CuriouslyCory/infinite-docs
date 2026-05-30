# CONTEXT

The binding glossary for **infinite-docs** — a drag-and-drop tool for documenting software
architecture as an infinitely-nestable graph. You place **Components** on a **Canvas**, link
them with **Connections**, and open a Component to **descend** into its interior Canvas,
recursing to any depth. The whole graph serializes to deterministic markdown for LLMs, and an
authenticated MCP server lets AI agents read and maintain the architecture.

This file is the source of truth for vocabulary. When code, issues, tests, ADRs, or UI copy
name a domain concept, use the term exactly as defined here — do not drift to the synonyms
this glossary explicitly rejects. Entries are added lazily, as terms crystallize; some terms
below are **defined now but implemented in a later milestone** and are marked as such.

## The Component / Node split (and Connection / Edge)

"Node" is overloaded in this stack (Node.js, the canvas library's node primitive), so we split
the user-facing word from the data word and never mix them:

| Concept | User-facing term (docs, UI, MCP verbs) | Data-model / graph-code term |
| --- | --- | --- |
| A documented thing on the graph | **Component** | **Node** |
| A link between two of them | **Connection** | **Edge** |
| A Component's connection point | **Port** (input / output) | **handle** (React Flow `target` / `source`) |

Rule of thumb: anything a human reads or an MCP agent calls says **Component** / **Connection** /
**Port**; anything in the Prisma schema, React Flow code, or graph algorithms says **Node** /
**Edge** / **handle**.

**Exception — Flow has no user/code split.** Unlike Component/Node and Connection/Edge, the
Flow vocabulary — **Flow** / `Flow`, **FlowSpec** / `FlowSpec`, **Polarity** / `FlowPolarity` —
uses the same word in user-facing and code surfaces. The split exists because "Node" collides
with Node.js and the canvas library's node primitive; "Flow" carries no such overload (React
Flow names the *library*, not a graph primitive we model), and users genuinely say "flow" when
they mean the same thing engineers do. The discipline is not weakened; the conditions that
motivated it do not apply here. When a future term arrives, default to applying the split;
deviate only when both conditions hold — the word is the natural user word AND it carries no
overload pressure.

## Terms

### Component
The user-facing unit of architecture you place, name, document, and open — a host, database,
external API, service, module, table, or anything else worth describing. Carries markdown
documentation. Backed by a **Node** in the data model. Components nest: opening one reveals its
interior **Canvas**. *(The graph data model and nesting land in a later milestone; the term is
canonical now.)*

### Node
The data-model representation of a Component: the stored graph vertex with
`parentId` (its containing Component, or null at the **Project** root), plus
`kind` (see **Component kind**), position (`posX`, `posY`), `documentation`, and a
soft-delete column (`deletedAt`). Never surfaced to users by this name.
*(The `Node` model, creation (including child Components under a validated parent
via `createNode` with a non-null `parentId`), scoped read at any depth
(**getCanvas**, with **breadcrumbs**), inline rename (`updateNode`, title only for
now), batch position writes (`updatePositions`), **Connection**/**Edge** wiring
(see **Edge**), and cascading **soft-delete** with **undo** (`deleteNode` removes
the Node, its subtree, and every incident or interior **Edge** as one batch;
`restoreNode` reverses it — see **Deletion id**) are realized now; broader
Component editing (`kind`, `documentation`) and reparenting (`move`) with cycle
prevention land in later milestones.)*

### Component kind (`NodeKind`)
A Component's category, stored on its **Node** as `kind: NodeKind`. One of six
values: `SERVICE`, `DATABASE`, `EXTERNAL_API`, `HOST`, `QUEUE`, and `GENERIC`
(the default). The word in prose and the enum name in code are **kind** /
`NodeKind` — never "type" (which collides with the canvas library's node-type
registry key) or "category". **Kind is cosmetic:** it drives only the
Component's icon and color and carries no behavioural or authorization meaning;
two Components differing only in kind are otherwise identical. User-facing labels
are *Service, Database, External API, Host, Queue, Generic*; the `EXTERNAL_API`
value is shown as "External API". *(The `kind` field and its six values are
realized now; later kinds, if any, are an additive change.)*

### Connection
The user-facing link between two Components, drawn on a **Canvas** by dragging from one
Component's output **Port** to another's input Port. Carries an optional **label** (untrusted
user content — stored verbatim, never interpreted; see the prompt-injection standing note).
Backed by an **Edge**. A Connection's direction is **structural**: the arrow always points at
the input Port, derived from the output→input (`sourceId`→`targetId`) ordering — never a stored
or user-set field, so it cannot lie (ADR-0009). A two-way relationship is **two Connections**
(one each way), each independently labelable. *(Drawing, labeling, and removing a Connection are
realized now — see **Edge** for the same-Canvas, no-self-link, and no-duplicate-active rules.
A Connection that carries one or more **FlowRoutes** wears a routed-count pill (**"N / M
routed"**) and exposes a **"+ flow"** affordance when selected by the owner, listing the
unrouted Flows from either endpoint. The **refinement Connection** — the inner Edge that
resolves a **boundary proxy** to a real Component one scope deeper — is realized now via the
gated cross-scope `routeFlow` writer (Slice 3 / ADR-0012); see **FlowRoute** and **Boundary
proxy**.)*

### Edge
The data-model representation of a **Connection**: the stored graph edge with `sourceId` and
`targetId` (both **Nodes**), an optional `label`, and a soft-delete column (`deletedAt`). The
`sourceId`→`targetId` ordering (output **Port** → input Port) IS the direction; the arrow is
structural, with no stored `direction` field (ADR-0009). Scoped to the Canvas it is drawn on
by an **explicit `canvasNodeId`** (the Component whose interior Canvas owns the Edge; null = the
**Project** root), rather than being inferred from its endpoints — endpoints can later span
scope levels (the M5 refinement Connection), so scope is recorded, not derived (ADR-0005).
Three invariants hold and are enforced **in the service, not the database** (ADR-0005): both
endpoints sit on the **same Canvas** as the Edge, an Edge never links a Node to itself, and no
two *active* (non-soft-deleted) Edges share the same source, target, and scope. The same-Canvas
invariant has exactly **one gated exception**: the **inner Edge** of a cross-scope **FlowRoute**,
whose **boundary endpoint** legitimately sits at a higher scope. Only `routeFlow` may write it,
and only when that endpoint is the Flow's owner; `connectNodes` stays strict (Slice 3 /
ADR-0012). Never surfaced to users by this name. *(The `Edge` model, `connectNodes`/`updateEdge`/`deleteEdge`, and the
**getCanvas** `interiorEdges` read are realized now; Connection removal as part of a Component
delete is undoable now (see **Deletion id**); partial-unique-index hardening of the de-dupe
rule landed via ADR-0010 — service-primary with a DB backstop that translates to the same
`ConflictError` — while undo of a standalone single-Connection `deleteEdge` remains a later
refinement.)*

### Port
A Component's connection point — the user-facing name for a React Flow **handle**. Every
Component exposes exactly two: an **input Port** (the `target` handle, rendered on the left,
where Connections arrive) and an **output Port** (the `source` handle, rendered on the right,
where Connections originate). A **Connection** is drawn by dragging output Port → input Port,
and that ordering is the Connection's structural direction — the arrow points at the input Port
(ADR-0009). Both Ports are **unbounded**: an output Port can feed many input Ports (fan-out) and
an input Port can receive from many output Ports (fan-in), with no connection-count cap; the
only limit is the de-dupe rule (no two *active* Connections share the same source + target +
scope; see **Edge** and ADR-0005). The word in prose and UI is **Port**; the React Flow code
word is **handle** (the same user-vs-code split as Component/Node) — never "connector",
"socket", "anchor", or "terminal". *(The two handles render on every Component now, and "Port"
is the canonical user word as of this slice. Exactly two Ports per Component — typed, named, or
per-protocol Ports are out of scope.)*

### Edge direction — retired
Removed in the slice that made the Connection arrow **structural** (ADR-0009). Direction was
once a cosmetic `EdgeDirection` field (`NONE` / `FORWARD` / `BIDIRECTIONAL`) the user cycled by
hand; it is no longer stored. The arrow now always points at the target's **input Port**
(output→input), derived from the `sourceId`→`targetId` ordering, and a two-way relationship is
**two Connections**. See **Connection**, **Port**, and ADR-0009.

### Canvas
A **derived view, not a stored entity.** The Canvas of a Component `N` is
`{ Nodes where parentId = N } ∪ { Edges where canvasNodeId = N }`. The Project root has its own
top-level Canvas (the Nodes with `parentId = null`). Because it is derived, a Canvas is never
written directly — you mutate Nodes and Edges, and the Canvas falls out. *(The Node half of
the derivation is realized now via **getCanvas**, and the Edge half is realized now too
(`{ Edges where canvasNodeId = N }`); reading a non-root scope is realized now via
**getCanvas**, and user-facing navigation into it is realized now via **Descent**.)*

### getCanvas
The single service read that materializes a **Canvas** for a given **Canvas
scope** in one round trip. Its full result is
`{ interiorNodes, interiorEdges, edgeFlows, boundaryProxies, flowPalettes, breadcrumbs }`,
derived without a per-level query walk. Because a Canvas is a *derived view*,
`getCanvas` returns the **Nodes** and **Edges** that fall out of the scope —
it is the read half of the Component/Node split, so its result is named in
**Node**/**Edge** terms in code and tests even though the feature is described
to users as "the interior **Components**". The `edgeFlows` field is the
per-Edge Flow aggregation that drives the routed-count pill on a Connection
(see **FlowRoute**): for each interior Edge, an entry
`{ edgeId, total, routed, unrouted, orphan, byKind }` where `total` is the
active **Flows** owned by either endpoint (loose — no polarity filter; a later
slice tightens), `routed` is the active **FlowRoutes** whose `outerEdgeId` is
this Edge with a still-live Flow, `orphan` covers FlowRoutes whose Flow was
soft-deleted by a re-parse (the wiring hangs visibly rather than vanishing),
and `byKind` is the per-`FlowKind` count of the routed set. The `boundaryProxies`
field is the transitively-derived **boundary proxy** list for the scope (each
`{ nodeId, title, kind, origin, outerEdgeId }`; see **Boundary proxy**), and
`flowPalettes` maps each in-scope proxy's `nodeId` to the first page of its
owner's **Flows** (`{ flows, hasMore }`) so the boundary-proxy **Flow palette**
renders without a second round trip — the overflow pages in through
`getFlowPalette`. *(Realized now — `getCanvas` returns all six keys for a
scope; `boundaryProxies` + `flowPalettes` landed with Slice 3 (#36) via one
recursive CTE folded into the existing `Promise.all`. A non-null scope that
resolves to no live Node in the Project is a not-found. See ADR-0001 for the
single-round-trip service contract, ADR-0004 for how the payload reaches the
client island, ADR-0005 for the explicit `canvasNodeId` Edge scope, ADR-0006
for the single recursive breadcrumb query, and ADR-0012 for the boundary
derivation + cross-scope refinement.)*

### Canvas scope
Which **Canvas** an operation is acting on. A Canvas has **no id of its own** (it
is derived, not stored), so a scope is identified by the **Component whose
interior Canvas it is**: the scope "is" a `Node`, and that Node's `id` is the
`parentId` of the Components on it. The **Project root** is the scope with no such
Component — represented as `parentId = null` in the data model and as the
sentinel string `"root"` at the canvas-island boundary (ADR-0004 keys the island
by scope so descending re-seeds the store). A non-root scope rides the **Project
route** as a bare Node id (`/p/[slug]/n/[nodeId]`); `"root"` stays an island
sentinel only and never appears in a URL (ADR-0007). Use **scope** for this concept
in prose and code; do not invent a `canvasId` (there is nothing to give an id to)
and do not call it a "level", "context", or "view". *(The root scope and reading
at non-root scopes are realized now via **getCanvas**; user-facing navigation into
non-root scopes is realized now via **Descent**.)*

### Breadcrumbs
The ordered ancestor chain of a **Canvas scope**: the **Components** from the
**Project** root down to, and including, the scope's own Component. Returned by
**getCanvas** as `breadcrumbs`, named in **Node** terms in code (like
`interiorNodes`) even though users see Components. Shape `{ id, title }[]`, ordered
**root → current** (root-most first, the current scope last). The **root scope**
has no Component, so its breadcrumbs are the empty array `[]` — no `"root"`
sentinel lives inside the chain (that string is a canvas-island key, not data;
ADR-0004). Computed in a **single recursive query**, never a per-level walk
(ADR-0006). The **trail** (this `{ id, title }[]` data) is distinct from the
**breadcrumb bar** (the UI that renders it): the bar prepends the **Project** as a
presentational root crumb — so the empty-at-root trail still shows the Project —
and marks the last entry as the current scope (ADR-0007). *(Realized now
end-to-end: computed in the data layer and rendered by the Descent breadcrumb bar.)*

### Descent
The act of opening a Component to enter its interior **Canvas**, moving one level deeper into
the graph. Recurses to any depth. *(Realized now: double-clicking a Component descends into its
interior **Canvas** at the **Project route** `/p/[slug]/n/[nodeId]`, with hover prefetch so the
descent feels instant. See ADR-0007.)*

### Boundary proxy
A read-only stand-in for an external system that a Component connects to on its *parent* Canvas,
projected inward so that dependency context is not lost on the way down. Boundary proxies are
**derived and inherited transitively** through the subtree (`boundary(H) = directBoundary(H) ∪
boundary(H.parent)`) — they are not independently editable Components, and no rows are persisted
for them. A proxy's **origin** distinguishes the two halves of that union: **direct** (an
external the *current* scope's Component connects to on its own parent Canvas) versus
**inherited** (projected down from an ancestor). The distinction drives the **collapse/group**
UX — inherited proxies fold away to keep deep Canvases uncluttered — and gates refinement: only
a direct proxy is **routable** here (it carries the outer Connection a palette drag refines),
because the cross-scope `routeFlow` writer binds an outer Edge incident to the current scope.
*(Realized now — derivation in **getCanvas** (`boundaryProxies`), read-only rendering as the
`boundary-proxy` Canvas node with its **Flow palette**, and the refinement drag all landed with
Slice 3 (#36 / ADR-0012, absorbing the M3 boundary work #13 + #14).)*

### Boundary endpoint
The endpoint of a cross-scope refinement **inner Edge** that is the **boundary proxy** — i.e. the
**Flow**'s owner, which lives at a higher **Canvas scope** than the inner Edge sits on. It is the
*one* endpoint allowed to violate the same-Canvas rule, and only inside `routeFlow`: the service
derives it from the Flow's owner and pins it against the supplied endpoints rather than trusting
an input, so an arbitrary foreign Node can never be smuggled in as a cross-scope endpoint (the
gated exception to ADR-0005; ADR-0012). The other endpoint — the interior Component on the
current Canvas — is the *interior endpoint*.

### Project
The root container of one architecture graph. Owned by a single user (`ownerId`) and addressed
by a unique, unguessable **capability-URL slug**. Holds the top-level **Canvas** and everything
that descends from it. Soft-deletable (`deletedAt`). The first concrete model in the system.

### Capability URL / slug
An unguessable, per-Project URL segment (`slug @unique`) that, by mere possession, grants
**read** access to that Project — no sign-in required. It is a bearer capability: the link *is*
the permission. **Mutations are never granted by the slug**; writes require the signed-in owner.
Anyone with the link can read; only the owner can change. *(See ADR-0002.)*

### Project route
The web address at which a Project opens — its **capability-URL slug** as a path segment —
landing on the Project's top-level **Canvas**. The route is a server component that resolves the
Project by slug (read access per ADR-0002), so it is reachable without sign-in; the **Canvas** is
mounted beneath it as a client-only island (ADR-0004). A missing or soft-deleted slug renders an
indistinguishable not-found. Interior Canvases hang off the same path at
`/p/[slug]/n/[nodeId]`, where `[nodeId]` is the scope's opaque **Node** id — URL addressing, not
prose, so it sits outside the Component/Node naming split (like the `slug` itself), and the
bearer-slug response headers cover it via the `/p/:path*` matcher (ADR-0007). *(Both the top-level
Canvas route and — via **Descent** — interior Canvas routing are realized now.)*

### Actor
The resolved identity of whoever is calling a service function:
`{ userId, scopes?, via?: "session" | "token" }`. Constructed at the edge (a tRPC procedure
resolves it from the session; the future MCP path resolves it from a token) and passed as the
second argument to **every** service function. Authorization is derived **only** from `userId`;
`via`/`scopes` are never used to make an authz decision. *(See ADR-0001.)*

### Service layer
The single deep module that is the **only** home for business logic and authorization. Every
operation is a plain function with the signature `(db, actor, input) => result`:
`db` is the Prisma client (the injectable seam), `actor` is the resolved caller, `input` is
validated data. tRPC routers and the future MCP server are thin adapters that resolve an Actor
and call into this layer. Authorization lives here — **not** in the tRPC guard — because the MCP
path will not pass through that guard. *(See ADR-0001 and ADR-0003.)*

### access (module)
The single home, inside the service layer, for authorization predicates. Exposes
`assertCanRead` (owner **or** valid capability-slug) and `assertCanWrite` (owner only). Every
service function routes its authorization decision through this module so the policy lives in
exactly one place. *(See ADR-0001 and ADR-0002.)*

### Deletion id
The handle that ties together one cascading soft-delete so it can be undone as a unit.
A single `deleteNode` mints one id and stamps it (`deletionId`) on every row it transitions to
deleted — the target **Node**, its subtree, every incident or interior **Edge**, every owned
**Flow** + owned **FlowSpec**, and every incident **FlowRoute** — and `restoreNode` clears
`deletedAt` for *exactly* the rows bearing that id, so an undo restores the operation's set and
nothing outside it. A `deleteEdge` that sweeps one or more incident FlowRoutes also mints a
`deletionId` and stamps both the Edge and the swept FlowRoutes, restored as one batch by
`restoreEdge`; a `deleteEdge` on an Edge with no incident FlowRoutes still mints **no**
`deletionId` (the "lone delete" carve-out preserved). A row removed by some other operation
never carries this id and is never revived by undoing a later one — a lone `deleteFlow` /
`unrouteFlow` / `deleteEdge`-without-routes sets `deletedAt` with no `deletionId`, and an
earlier delete carries its own id. It is a *grouping of soft-deleted rows*, not a stored
history: do not call it a "transaction" (the database mechanism that writes it), a "version"
or "snapshot" (nothing is copied — rows are flagged in place), or an "audit log". Named in
**Node**/**Edge**/**Flow**/**FlowRoute** terms in code; users see only "delete" and "undo".
*(Realized now via `deleteNode`/`restoreNode` and `deleteEdge`/`restoreEdge` for cascaded
edges; see ADR-0008, ADR-0014 (the `deleteEdge`/`restoreEdge` cascade), and ADR-0011. The
id is a bare stamped column today — a durable `Deletion` entity and an MCP undo tool are
deferred, additive future work.)*

### Soft-delete + undo
Deletes set a `deletedAt` timestamp rather than removing rows; reads filter out soft-deleted
records; the operation is reversible. This matters specifically because AI agents mutate the
graph, and a recoverable delete is the safety net for an automated change gone wrong. *(Realized
now for a Component: `deleteNode` cascades a soft-delete across the Node, its subtree, every
incident or interior **Edge**, and every owned **Flow** + owned **FlowSpec** as one
**Deletion id**, and `restoreNode` reverses exactly that set (ADR-0008 + ADR-0011). Both are
**writes** — owner-only, never slug-granted (ADR-0002). The `Project` model also carries
`deletedAt` and all reads filter it; Project-level cascade remains future.)*

### Flow
A named, directional unit of data movement a **Component** exposes — an OpenAPI operation, a
WebSocket channel, an SSE stream, a function call, an event. Owned by its Component
(`ownerNodeId` on the data side) and exists on the owner whether or not anything is calling it:
an API exposes `GET /pets` whether or not a client is wired up. A first-class row, individually
addressable and individually soft-deletable, so every named capability is something an MCP
agent can list, edit, or remove without touching the **Connection** that carries it. Carries a
stable `key` (e.g. `"GET /pets"`), an UNTRUSTED `title` (display label), an optional
`signature` (the parsed contract fragment as `Json?`), a **kind** (see **Flow kind**), and a
**polarity** (see **Polarity**). A Flow's `key` is unique among active rows of the same owner
— the de-dupe rule `(ownerNodeId, key)`, ADR-0005 style with the ADR-0010 partial-unique
backstop (`idx_flow_dedup`). A Flow may be **derived** from a **FlowSpec** (`sourceSpecId != null`)
or **user-authored** (`sourceSpecId = null`). *(Realized now via `attachFlowSpec` / `addFlow` /
`updateFlow` / `deleteFlow`, listed in the Component's **Flow palette**, and surfaced as the
"N flows" pill on the Component body. Same-Canvas baseline binding of a Flow to a **Connection**
— the `FlowRoute` — is realized now via `routeFlow` / `unrouteFlow`, surfaced as the routed-count
pill on the Connection and the "+ flow" affordance when a Connection is selected by the owner.
Cross-scope refinement routing and palette rendering on **boundary proxies** land in subsequent
slices. See ADR-0011.)*

### FlowSpec
The imported contract — an OpenAPI document, an AsyncAPI document, a TypeScript signature, a
GraphQL schema, or hand-authored `CUSTOM` prose — that materializes a set of **Flows** on its
owner **Component**. 1:1 with a Component (`ownerNodeId @unique`): exactly one current
FlowSpec per Component. The spec is the source of truth; Flow rows are its parsed projection,
regenerated by re-parse. `source` is **UNTRUSTED user-pasted content** — stored verbatim,
parsed only by a bounded loader (size + depth caps so a hostile spec cannot OOM), and never
interpolated (prompt-injection standing note, parse-time clause). A malformed spec stores
`parseError`, creates zero Flows, and never throws to the caller. Re-pasting is
**non-destructive**: matching keys preserved, dropped keys soft-deleted with a fresh
**Deletion id** per re-parse batch (the same handle the cascade uses, minted by a different
operation — `restoreNode` does not unwind a re-parse batch; orphan ids are harmless), so
downstream wiring orphans visibly rather than vanishing silently. *(Realized now for OpenAPI;
ASYNCAPI / TS_SIGNATURE / GRAPHQL / CUSTOM persist source and record `parseError` until their
parsers land additively. See ADR-0011.)*

### Polarity (`FlowPolarity`)
A **Flow**'s directional relationship to its **owner** **Component**: `INBOUND` (the owner
*consumes* — e.g. `GET /pets` on an API) or `OUTBOUND` (the owner *emits* — SSE, events,
server-pushed messages). Polarity is **owner-relative**: it answers "from the owner's
perspective, does data come in or go out?", which is the only frame in which a bidirectional
pipe resolves to **two Connections** under ADR-0009 without storing a `direction` field
anywhere. When a Flow is later routed onto a Connection (subsequent slices), polarity must
match the rendered arrow: an `OUTBOUND` Flow rides an **Edge** whose `sourceId` is the owner;
an `INBOUND` Flow rides an Edge whose `targetId` is the owner. The word in prose and UI is
**polarity**; the type name in code is `FlowPolarity` — the same prose/type-name pattern
**Component kind** / `NodeKind` uses. Never "direction" (that's structural, taken, and
ADR-0009 forbids re-introducing it). *(Realized now as a per-Flow field; the polarity-vs-arrow
consistency check at route time lands with a subsequent slice. ADR-0011 records the decision.)*

### Flow palette
The read-only UX surface listing a **Component**'s **Flows**. Surfaces on the
**Component-detail panel** that opens when the owner selects a Component on the **Canvas** —
alongside the paste field for its **FlowSpec** — and inside the **"+ flow"** popover that
opens when the owner selects a **Connection** (so the unrouted Flows on either endpoint are
pickable in place). Each item shows the Flow's `title`, `kind`, and `polarity`. When the
Component owns at least one Flow, its node body wears a **"N flows" pill** to signal the
palette is non-empty. *(Realized now on the Component-detail panel of a Component you own,
inside the per-Connection "+ flow" popover, and — since Slice 3 (#36) — on the **boundary
proxy**: the same surface projected inward, where each item carries a refinement Port so a
child Component can route the external Flow onto its interior pipe (ADR-0012). The first page
ships in **getCanvas** `flowPalettes`; the overflow pages in via `getFlowPalette`.)*

### FlowRoute
The binding that says *"this **Connection** carries this **Flow**"* — a first-class row that
attaches a **Flow** to an **Edge** at a **Canvas scope**. Names exactly one `outerEdgeId`
(the Connection at this scope that carries the Flow) and zero-or-one `innerEdgeId` (the
**refinement Connection** one scope deeper — the inner **Edge** that resolves a **boundary
proxy** to the real Component, written by the gated cross-scope `routeFlow` since Slice 3 /
ADR-0012). An inner Edge is a **shared pipe**: one inner Edge can carry **many FlowRoutes**
(`innerEdgeId` has no uniqueness), so two Flows refined over the same interior pair converge
on one Edge, and the soft-delete sweep is reference-counted — an inner Edge dies only with its
last active FlowRoute. Same word user-facing and in code — applies the **Flow** no-split
convention (the
"Node" overload that motivated the Component/Node split does not apply). Carries `projectId`
for authz and cascade-index friendliness, soft-delete columns (`deletedAt`, `deletionId`),
and is owner-only writable via `routeFlow` / `unrouteFlow`. A FlowRoute's `flowId` must
reference an active **Flow** whose `ownerNodeId` is one endpoint of the outer **Edge** —
the *touches-endpoint* invariant, enforced now in its weaker, direction-blind form; the
polarity-vs-arrow refinement (INBOUND ⇒ owner = target, OUTBOUND ⇒ owner = source) is
service-enforced in a subsequent slice (Slice 4 / ADR-0013). De-dupe is `(outerEdgeId, flowId)` among active rows
— the **ADR-0010 named pattern**, third adopter (`idx_flow_route_dedup`, partial unique
backstop; service-primary `findFirst` is the readable fast path; both translate to
`ConflictError` with `details.conflictingFlowRouteIds`). The inner-Edge and FlowRoute writes
use `createMany({ skipDuplicates })` (`ON CONFLICT DO NOTHING`) so a concurrent racer never
aborts the route's transaction — convergence on a shared inner Edge, not a retry loop
(ADR-0012). *(Realized now for same-Canvas baseline routing via `routeFlow` / `unrouteFlow`,
surfaced as the `edgeFlows` aggregation in **getCanvas**, the routed-count pill on the
Connection, and the "+ flow" popover on a selected Connection — and, since Slice 3 (#36),
cross-scope refinement (the `innerEdgeId` writer) and palette rendering on **boundary
proxies**, with the drag-from-palette gesture. Only polarity validation (Slice 4 / ADR-0013)
remains. See ADR-0011 (Flow foundation), ADR-0012 (cross-scope writer), and the master plan
at `docs/plans/flow-routed-connections.md`.)*

### Flow kind (`FlowKind`)
A **Flow**'s category, stored on it as `kind: FlowKind`. One of seven values: `GENERIC` (the
default — a hand-authored Flow with no formal contract), `OPENAPI_OPERATION`,
`ASYNCAPI_CHANNEL`, `SSE_STREAM`, `WEBSOCKET`, `FUNCTION_CALL`, `EVENT`. The word in prose and
the enum name in code are **kind** / `FlowKind` — the same pattern as **Component kind** /
`NodeKind`. **Kind is cosmetic**: it drives palette icons and how an inspector formats the
`signature` payload; it does not change authorization, routing, or de-dupe. New kinds are an
additive change.

### Flow spec kind (`FlowSpecKind`)
A **FlowSpec**'s source format, stored on it as `kind: FlowSpecKind`. One of five values:
`OPENAPI`, `ASYNCAPI`, `TS_SIGNATURE`, `GRAPHQL`, `CUSTOM`. The value selects which parser
materializes Flows from `source`; `CUSTOM` is for a hand-authored contract the canonical
parsers do not cover. The word in prose and the enum name in code are **spec kind** /
`FlowSpecKind`. *(`OPENAPI` is the parser realized now; `ASYNCAPI` / `TS_SIGNATURE` /
`GRAPHQL` / `CUSTOM` persist source and record `parseError` until their parsers land
additively.)*

## Standing notes

### Prompt-injection standing note
Component documentation, titles, and any other user-authored content are **untrusted input**.
When this content is later fed to an LLM (markdown export, MCP resources), it must be treated as
**data, never instructions**. A Component's docs can say "ignore previous instructions" — and
the system must not. Every code path that hands graph content to a model carries this obligation.
Defenses live at the output/serialization boundary (added in a later milestone); today we only
adopt the mindset — store text verbatim and never interpolate user content into queries.

**Parse-time trust too.** Untrusted content that is later *parsed* — a pasted **FlowSpec**'s
`source`, future contract imports — must go through a **bounded loader** with size and depth
caps so a hostile input cannot OOM the server before it ever reaches the output boundary. The
caps belong to the parser itself (testable in isolation), not just the API surface; a future
caller bypassing input validation must still hit the cap.
