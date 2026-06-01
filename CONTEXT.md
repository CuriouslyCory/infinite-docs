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
Flow vocabulary — **Flow** / `Flow`, **FlowSpec** / `FlowSpec`, **Interaction** / `FlowInteraction` —
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
documentation, edited in the **Component-detail panel** through a WYSIWYG editor that renders
the markdown formatted and toggles to an editable surface with debounced, optimistic autosave
(no save button; the stored markdown string is the source of truth — ADR-0015). Backed by a
**Node** in the data model. Components nest: opening one reveals its interior **Canvas**.
*(The graph data model and nesting land in a later milestone; the term is canonical now.)*

### Node
The data-model representation of a Component: the stored graph vertex with
`parentId` (its containing Component, or null at the **Project** root), plus
`kind` (see **Component kind**), position (`posX`, `posY`), `documentation`, and a
soft-delete column (`deletedAt`). Never surfaced to users by this name.
*(The `Node` model and the operations on it — `createNode` (root or child under
a validated parent), `getCanvas` (with **breadcrumbs**), `updateNode` (title
only), `updateNodeDocumentation` (the narrow owner-only autosave feeding the
detail-panel markdown editor — ADR-0015), `updatePositions` (batched on
drag-stop), and the cascading `deleteNode` / `restoreNode` pair (see **Deletion
id**) — are realized now. **Connection**/**Edge** wiring is its own entry.
Broader Component editing (`kind`) and reparenting (`move`) with cycle
prevention land in later milestones.)*

### Component kind (`NodeKind`)
A Component's category, stored on its **Node** as `kind: NodeKind`. The value
set spans the hierarchy the tool documents — global infrastructure down to
individual code branches: `GENERIC` (the default), `GLOBAL_INFRA`, `REGION`,
`DATACENTER`, `NETWORK`, `HOST`, `CONTAINER`, `SERVICE`, `MICROSERVICE`, `CRON`,
`QUEUE`, `APPLICATION`, `MODULE`, `CLASS`, `FUNCTION`, `VARIABLE`, `BRANCH`,
`DATABASE`, `TABLE`, `STORED_PROCEDURE`, `EXTERNAL_API`, `ENDPOINT`, `WEBHOOK`,
`TOPIC`, `CONSUMER`, `PRODUCER`. The word in prose and the enum name in code are
**kind** / `NodeKind` — never "type" (which collides with the canvas library's
node-type registry key) or "category". **Kind is cosmetic:** it drives only the
Component's icon and color and the **kind affinity** ranking the picker offers,
and carries no behavioural or authorization meaning; two Components differing
only in kind are otherwise identical — the expanded value set does not weaken
this: no kind grants nesting permission, gates a service operation, or alters
de-dupe (ADR-0018). User-facing labels are spelled out in `KIND_LABEL` (keyed by
`NodeKind`, so a new kind fails to compile until labelled), with multi-word kinds
written in full (`EXTERNAL_API` → "External API", `STORED_PROCEDURE` → "Stored
procedure"). A Component's kind is editable after creation via the narrow
owner-only `updateNodeKind` mutation (the **kind palette** reopens from the
**Component-detail panel**'s Kind row), never slug-granted (ADR-0002). *(The
expanded enum, the **kind palette** picker, **kind affinity** ranking, and
`updateNodeKind` are all realized now. Further kinds remain an additive change.
See ADR-0018, ADR-0019.)*

### Kind affinity (`KIND_AFFINITY`)
The ordered list of Component **kinds** the picker promotes when a Component is
created or re-kinded inside a parent of a given kind — inside a `DATABASE`, the
palette ranks `TABLE` / `STORED_PROCEDURE` first; inside a `HOST`, `CONTAINER` /
`SERVICE` / `MICROSERVICE` / `CRON`; inside a `FUNCTION`, `BRANCH` / `VARIABLE`.
The Project root has its own affinity keyed by the sentinel `"ROOT"`
(infrastructure-flavored: `GLOBAL_INFRA`, `DATACENTER`, `REGION`, `NETWORK`,
`HOST`, `EXTERNAL_API`). **Affinity is presentation-only:** every kind remains
selectable below the affined ones, the service accepts any kind regardless of
parent kind, and kind stays cosmetic — the picker cannot encode a rule the data
model does not (ADR-0019). The map is a client-safe constant in
`~/lib/node-kinds.ts` alongside `KIND_LABEL` and `KIND_ICON`; it is not stored,
not server-derived, and not a function of **Canvas scope** (the same ranking
applies under any scope whose Component carries that kind). The word in prose and
the constant name in code are **kind affinity** / `KIND_AFFINITY` — never "kind
suggestions" (names the UI output, not the relation), "kind ranking" (names the
mechanism), or "nesting rules" / "parent-child constraints" (actively wrong — no
constraint exists). *(Realized now alongside the **kind palette**. See ADR-0019.)*

### Kind palette
The Command-palette UX surface for picking a **Component kind** — a searchable,
keyboard-navigable list (built on the shadcn/`cmdk` `Command` primitive) that
replaced the original `<select>` dropdown. Renders the full `NodeKind` set with
the **kind-affine** entries grouped under a "Suggested" heading above a separator
and the remainder under "All kinds" below, preserving the invariant that every
kind is always reachable (search spans both groups). It is the only
kind-selection surface in the canvas: the "Add Component" control opens it, and —
since Slice 2 — the **Component-detail panel** reopens the same palette to change
a Component's kind. Applies the same prose/UI pattern **Flow palette** does —
*palette* names the surface, not the library. Never "kind picker" (too generic —
it could name a `<select>`), "command palette" (collides with the library term),
or "kind selector". *(Realized now; the `<select>` it replaces is retired. The
canonical-command-palette ADR is deferred until a second palette adopter, per
docs-travel-with-code-slices.)*

### Connection
The user-facing link between two Components, drawn on a **Canvas** by dragging between their
**Ports** (in either direction — Ports are non-directional). Carries an optional **label**
(untrusted user content — stored verbatim, never interpreted; see the prompt-injection standing
note). Backed by an **Edge**. A Connection is **undirected**: it has no stored direction, and
its rendered arrowheads are **derived** from the **Flows** routed on it — none → a plain line,
one direction → one arrowhead, both → arrowheads at both ends (a WebSocket is ONE Connection,
not two). The derivation reads each routed Flow's **Interaction** verb (REQUEST/SUBSCRIBE point
at the owner, PUSH away, DUPLEX both), so the arrow follows the traffic and cannot lie
(ADR-0023, superseding ADR-0009). *(Drawing, labeling, and removing a Connection are
realized now — see **Edge** for the same-Canvas, no-self-link, and no-duplicate-active rules.
A Connection that carries one or more **FlowRoutes** wears a routed-count pill (**"N / M
routed"**) and exposes a **"+ flow"** affordance when selected by the owner, listing the
unrouted Flows from either endpoint. The **refinement Connection** — the inner Edge that
resolves a **boundary proxy** to a real Component one scope deeper — is realized now via the
gated cross-scope `routeFlow` writer (Slice 3 / ADR-0012); see **FlowRoute** and **Boundary
proxy**. A refinement route leaves the *parent* Connection's routed-count pill stale until the
viewer ascends (a fresh **getCanvas**) — a deliberate no-cross-scope-round-trip trade-off, see
ADR-0012 Consequences. The "+ flow" affordance offers **every** unrouted Flow from either
endpoint — a Connection is undirected, so any owner-endpoint Flow can ride it; the Flow's
**Interaction** verb decides which way its arrow points, not whether the route is legal (the
former polarity filter and reverse-Connection offer are retired — ADR-0023, superseding
ADR-0013). The full undirected-arrow rendering — and the rewrite of the structural-arrow
language just above — lands in a later slice of the same rollout.)*

### Edge
The data-model representation of a **Connection**: the stored graph edge with `sourceId` and
`targetId` (both **Nodes**), an optional `label`, and a soft-delete column (`deletedAt`).
`sourceId`/`targetId` are just the two endpoints in arbitrary draw order — they carry **no
direction** and there is no stored `direction` field; a Connection is undirected and its
arrowheads are derived from the **Flows** routed on it (ADR-0023; the flow-derived rendering
lands in a later slice of that rollout). Scoped to the Canvas it is drawn on
by an **explicit `canvasNodeId`** (the Component whose interior Canvas owns the Edge; null = the
**Project** root), rather than being inferred from its endpoints — endpoints can later span
scope levels (the M5 refinement Connection), so scope is recorded, not derived (ADR-0005).
Three invariants hold and are enforced **in the service, not the database** (ADR-0005): both
endpoints sit on the **same Canvas** as the Edge, an Edge never links a Node to itself, and no
two *active* (non-soft-deleted) Edges share the same scope and **unordered** endpoint pair
(A→B and B→A are the same Connection; ADR-0023). The same-Canvas
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
A Component's connection point — the user-facing name for a React Flow **handle**.
**Non-directional** (ADR-0023): a Component is not directional, so a Port carries no
input/output role. Every Component exposes two (rendered left and right) purely for
drag-discoverability; under React Flow's `ConnectionMode.Loose` either can start *or* end a
**Connection**, in either direction. Which way a Connection is drawn carries no meaning — its
arrowheads are derived from the **Flows** routed on it (see **Connection**, **Interaction**).
Both Ports are **unbounded**: a Port can feed many Connections and receive from many (fan-out
and fan-in), with no connection-count cap; the only limit is the de-dupe rule (no two *active*
Connections between the same **unordered** Component pair on a scope; see **Edge** and ADR-0023).
The word in prose and UI is **Port**; the React Flow code word is **handle** (the same
user-vs-code split as Component/Node) — never "connector", "socket", "anchor", or "terminal".
*(The two non-directional handles render on every Component now; the former input/output
framing retired with ADR-0023. Typed, named, or per-protocol Ports remain out of scope.)*

### Edge direction — retired (twice)
Direction has never been a stored field on the Edge. It was first a cosmetic `EdgeDirection`
enum (`NONE` / `FORWARD` / `BIDIRECTIONAL`) the user cycled by hand (removed by ADR-0009, which
made the arrow *structural* — derived from the `sourceId`→`targetId` ordering). ADR-0023 then
removed even that structural meaning: `sourceId`/`targetId` are just the two endpoints in
arbitrary draw order, the de-dupe pair is **unordered**, and a Connection's arrowheads are
**derived from the Flows routed on it** (see **Connection**, **Interaction**). Re-introducing a
stored `direction` (or a `polarity`-on-Edge) field regresses both ADRs. See **Connection**,
**Port**, **Interaction**, and ADR-0023.

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
per-Edge Flow aggregation that drives the routed-count pill AND the derived
arrowheads on a Connection (see **FlowRoute**, **Interaction**): for each
interior Edge, an entry
`{ edgeId, total, routed, unrouted, orphan, byKind, arrowAtSource, arrowAtTarget }`
where `total` is the active **Flows** owned by either endpoint (loose — any
owner-endpoint Flow can ride the Connection; ADR-0023), `routed` is the active
**FlowRoutes** whose `outerEdgeId` is this Edge with a still-live Flow, `orphan`
covers FlowRoutes whose Flow was soft-deleted by a re-parse (the wiring hangs
visibly rather than vanishing), `byKind` is the per-`FlowKind` count of the
routed set, and `arrowAtSource` / `arrowAtTarget` count how many live routed
Flows point their arrow at the Edge's stored `source` / `target` endpoint
(derived per Flow from `(owner, interaction)` — the canonical rule lives in
`~/lib/flow-direction`; the client renders a `markerStart`/`markerEnd` from
them, both → a two-way Connection, neither → an undirected line; ADR-0023). The
`boundaryProxies` field is the transitively-derived **boundary proxy** list for
the scope (each `{ nodeId, title, kind, origin, outerEdgeId }`, where
`outerEdgeId` is the single incident outer Connection a palette drag refines —
a Connection is undirected, so any Flow rides it regardless of interaction
(ADR-0023); see **Boundary proxy**), and
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
`interiorNodes`) even though users see Components. Shape `{ id, title, kind }[]`,
ordered **root → current** (root-most first, the current scope last). The `kind`
is carried so the **kind palette** can compute **kind affinity** for the current
scope without a second round trip; the breadcrumb **bar** does not render it
today, though the data is available for future kind-flavored crumb icons. The **root scope**
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
UX — inherited proxies fold away into a single **boundary group** (see entry) to keep deep
Canvases uncluttered — and gates refinement: only a direct proxy is **routable** here (it carries
the outer Connection a palette drag refines), because the cross-scope `routeFlow` writer binds an
outer Edge incident to the current scope.
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

### Boundary group
The single read-only Canvas node a **Canvas** renders in place of its inherited **boundary
proxies** — bundled so a deep Canvas with many ancestors is not buried under N stand-ins for
externals routed at scopes the viewer cannot act on here. Collapsed by default; expanding reveals
each inherited proxy by title and **Component kind** but no **Flow palette** (inherited proxies
are context, not a work surface — only **direct** proxies are routable at this scope; see
**Boundary proxy** and ADR-0012). Like the proxies it contains, a Boundary group is **derived,
never persisted**: it has no **Node** row, no **Edge**, and no interior **Canvas scope** of its
own — it is a render-layer regrouping of the `boundaryProxies` whose `origin = "inherited"` at
the scope it appears on. Read-only in the same sense as a boundary proxy: not draggable,
selectable, deletable, or descendable — i.e. a **passive node** (see entry). The code term is
**`BoundaryGroupNode`** (React Flow node type `"boundary-group"`), mirroring the
**Component**/**Node** split — and distinct from React Flow's own built-in `"group"` node type (a
parent-of-children layout primitive this is not). Renders even for a single inherited proxy, so a
refetch flipping the inherited count never reshuffles the Canvas surface (ADR-0016). *(Realized as
the #14 grouping follow-up on top of Slice 3's per-proxy rendering — same derivation
(`deriveBoundaryProxies`), no service change.)*

### Passive node
A derived, read-only React Flow node on a **Canvas** — currently a **boundary proxy** or a
**boundary group** — excluded from the three interactive surfaces a **Component** participates
in: the **Component-detail panel** (no editable record exists), **Descent** (no interior
**Canvas scope** to open into), and hover-prefetch (nothing to warm). Passive nodes carry no
**Node** row, are never `draggable`, `selectable`, or `deletable`, and are partitioned out of
every interactive pointer handler by a single discriminator (`isPassiveNode` in `canvas.tsx`)
so a new passive kind composes by extension rather than by sprinkling fresh guards through the
click / double-click / hover paths (ADR-0016). The term is **passive** — not "read-only" (which
is overloaded with the capability-URL viewer surface, owner-edit vs viewer-read) and not
"non-interactive" (which over-claims — passive nodes still expand and collapse their own
internals; they are inert *with respect to the Canvas's interactive surfaces*, not globally
inert).

### Project
The root container of one architecture graph. Owned by a single user (`ownerId`) and addressed
by a unique, unguessable **capability-URL slug**. Holds the top-level **Canvas** and everything
that descends from it. Soft-deletable (`deletedAt`). The first concrete model in the system.

### Capability URL / slug
An unguessable, per-Project URL segment (`slug @unique`) that, by mere possession, grants
**read** access to that Project — no sign-in required. It is a bearer capability: the link *is*
the permission. **Mutations are never granted by the slug**; writes require the signed-in owner.
Anyone with the link can read; only the owner can change. A non-owner who holds the slug is a
**viewer** — the canonical term for this person in prose, code (`canEdit = false`), and UI ("View
only"); never "visitor" or "guest". The web client presents a **read-only mode** to a viewer
(every edit affordance hidden, a read-only **Component-detail panel**, a "View only" header
badge), but that mode is *presentation, not authorization*: every mutation is still denied at the
service layer regardless of what the client renders (issue #16). The slug is one of the system's
two bearer secrets — the **API token** is the other (the slug grants link-based *read* to one
Project; an API token grants an agent the minting user's access over the MCP path); both are
treated as secrets in logs. *(See ADR-0002, ADR-0020.)*

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
resolves it from the session; the **MCP path** resolves it from a token via `resolveActorFromToken`
— realized now, #18) and passed as the second argument to **every** service function. Authorization
is derived **only** from `userId`; `via`/`scopes` are never used to make an authz decision.
*(See ADR-0001, ADR-0022.)*

### Service layer
The single deep module that is the **only** home for business logic and authorization. Every
operation is a plain function with the signature `(db, actor, input) => result`:
`db` is the Prisma client (the injectable seam), `actor` is the resolved caller, `input` is
validated data. tRPC routers and the MCP server are thin adapters that resolve an Actor
and call into this layer. Authorization lives here — **not** in the tRPC guard — because the MCP
path does not pass through that guard. *(See ADR-0001 and ADR-0003.)*

### access (module)
The single home, inside the service layer, for authorization predicates. Exposes
`assertCanRead` (owner **or** valid capability-slug) and `assertCanWrite` (owner only). Every
service function routes its authorization decision through this module so the policy lives in
exactly one place. Its `OwnedResource { ownerId }` shape is **structural**, not Project-coupled —
it authorizes over any row whose owning identity is `ownerId`/`userId` (an **API token**'s
`userId` feeds it directly), so adding an owned resource type needs no new predicate.
*(See ADR-0001 and ADR-0002.)*

### API token (`ApiToken`)
A bearer secret a signed-in user mints so an **agent** (an AI client speaking the MCP path) can
call the system *as that user* — the system's **second bearer secret** alongside the
**capability-URL slug** (the slug grants link *read* to one **Project**; this grants the user's
access over the MCP path). Minted from the **Connect-an-agent page**, **shown exactly once**, and
stored only as a **token hash** plus a non-secret **token prefix** for display — the raw token
never persists and is never logged (the slug's secret-in-logs posture, ADR-0002). Carries **token
scopes** and an **expiry**, and is **revocable** (soft — `revokedAt`, keeping the prefix/audit
trail). Owned by a `userId`; mint/list/revoke authorize through **access** on `userId` only, and a
token belonging to another user is reported not-found (no existence disclosure). The word is "API
token" user-facing and `ApiToken` in code — never "API key", "agent token"/"agent key" (the agent
*consumes* it, it is not the agent's identity), or "PAT". The service verbs are
`createApiToken` / `listApiTokens` / `revokeApiToken` ("mint" is prose only); the UI button says
"Generate token". When a token resolves to an identity (#18, the MCP path) it produces an **Actor**
with `via: "token"`; authorization still derives only from `userId`. *(Minting, hash-at-rest,
prefix, and revocation are realized now; token→Actor resolution is **realized now** (#18, the MCP
read path) via `resolveActorFromToken`; scope enforcement remains a later milestone. See ADR-0020,
ADR-0021, ADR-0022.)*

### Token hash
How an **API token** persists: the raw token is run through a **keyed HMAC** (SHA-256) with a
server-side **token pepper** and only the resulting digest is stored (`tokenHash @unique`), so the
database never holds a replayable credential. #18 verifies a presented token by re-deriving the
same HMAC and matching the stored digest — the raw value exists only in transit and in the one-time
reveal. HMAC, not bcrypt/argon2: the token is 256-bit CSPRNG entropy, so slow password hashing buys
nothing and a deterministic keyed digest is exactly what lookup-by-hash needs. Never "encrypted
token" (a one-way digest, not reversible ciphertext) or "salted hash" (the secret is a server-wide
**pepper**, not a per-row salt — a salt would break lookup). *(See ADR-0020.)*

### Token pepper
The single server-side secret keying every **token hash** — `API_TOKEN_PEPPER`, added to the
schema-validated env (`src/env.js` server schema **and** `runtimeEnv`) but read directly from
`process.env` in `token-hash.ts` so a service test needn't load unrelated auth secrets (the
test-DB seam, ADR-0003). It is a **pepper**, not a **salt**: one application-wide *secret* whose
compromise (with a DB dump) is what an attacker would need to brute-force tokens offline, so it
lives only in the environment. A `keyVersion` stamped per token selects which pepper keyed it, so
the pepper can be rotated without a hash migration; rotating it otherwise invalidates all tokens of
that version by design. Treated as a top-tier secret in logs, like the slug. *(See ADR-0020.)*

### Token scopes
The capability labels an **API token** carries (today only `read`), stored on the `ApiToken` and
later copied onto the **Actor** it resolves to. **Scopes are stored, not enforced**: per **Actor**
and ADR-0001, authorization derives only from `userId`; `scopes`/`via` never decide an authz
outcome. They exist now so the wire/DB shape is stable before any scope-gated capability lands, at
which point enforcement is an additive `access`-module change. The word is **scopes** in prose, UI,
and code — never "permissions" (over-claims enforcement that does not exist) or "roles".
*(See ADR-0021.)*

### Connect-an-agent page
The signed-in, owner-only surface (`/connect`) where a user mints, lists, and revokes **API
tokens** for connecting an **agent**. User-facing title is **"Connect an agent"**; the artifacts it
manages are **API tokens**. It is the *producer* side of the token; the *consumer* side (resolving
a token to an **Actor** over MCP) is **realized now** (#18, see ADR-0022). Not a "settings", "API
keys", or "developers" page — it is framed around the user's goal (connect an agent), per the
convenience philosophy.

### Agent
An AI client that speaks the **MCP path**, authenticating with an **API token** that grants it the
minting user's access. The agent *consumes* the token; the token is **not** the agent's identity (so
never "agent token" / "agent key" — see **API token**). It reads the architecture as deterministic
**markdown** **MCP resources** and, in later milestones, maintains it via MCP tools. The word is
**agent** — never "bot", "client", "consumer", or "AI" as the domain noun. *(The authenticated read
surface an agent connects to is realized now via #18; write tools are #19/#20.)*

### MCP path
The authenticated route — `/api/mcp`, a Next.js route handler speaking **Streamable HTTP** — through
which an **agent** reads (and, in later milestones, maintains) the architecture. A **thin adapter**
(ADR-0001): it resolves an **Actor** from a bearer **API token** (`resolveActorFromToken`, rejecting
missing / revoked / expired tokens with one indistinguishable 401 — **no anonymous access**) and
calls the service layer, holding no business logic or authorization of its own. The system's **second
transport adapter** after the tRPC API; unlike that API, the MCP path does not pass through the tRPC
guard, which is why authorization lives in the service layer (**access** module). The word is **MCP
path** / **MCP endpoint** / **MCP server** — never "MCP API" (redundant; tRPC is "the API layer"),
"the agent endpoint" (the agent consumes it; the endpoint is not the agent's), or "MCP route". *(The
read surface is realized now via #18 — read-only; see ADR-0022. Write tools are #19/#20.)*

### MCP resource
A read-addressable unit an **agent** dereferences over the **MCP path**, returning a **Project**'s
deterministic **markdown**. The three — **`index`**, **`project`**, **`subtree`** — are the
MCP-addressable face of **Markdown export**'s three modes, **not a new data vocabulary** (the same
map, addressed by URI). Addressed under the `architecture://` scheme by internal `projectId` (and a
`nodeId` for `subtree`) — **never by a user id**; an Actor reads only its own projects, and
`resources/list` enumerates only those (reusing the owner-scoped `listProjects`). The word is
**resource** — the MCP-spec native term, so no Component/Node split applies (the overload that
motivates the split is absent). Never "tool" (a **tool** invokes or mutates — #19 / #34 own those),
"endpoint" (that names the route), or "query". *(Realized now via #18; #38's Flow resources
(`flow/:id`, `flow-route/:id`) append additively. See ADR-0017, ADR-0022.)*

### llms.txt
The served discovery document at `/llms.txt` that tells an **agent** how to reach the **MCP path**,
authenticate (a bearer **API token** from the **Connect-an-agent page**), and address the **MCP
resources**. **Generated**, not hand-authored — its resource catalog renders from the same source the
**MCP server** registers from, so the doc and the live `resources/list` cannot drift. Honest about
the grant (ADR-0021): it describes capability ("a token acts on behalf of the minting user"), never a
"read-only scope" the token does not carry — the MCP surface is read-only *at this version*, not the
token. Carries the **prompt-injection standing note** that graph content is **data, not
instructions**. Never "manifest", "sitemap", or "robots.txt for AI". *(Realized now via #18; #34/#38
extend its vocabulary as they add Flow tools / resources. See ADR-0022.)*

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
`signature` (the parsed contract fragment as `Json?`), a **kind** (see **Flow kind**), and an
**interaction** (see **Interaction**). A Flow's `key` is unique among active rows of the same owner
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

### Interaction (`FlowInteraction`)
How a **Flow**'s **owner** **Component** participates in the interaction — the owner-relative
verb from which a **Connection**'s arrowheads are *derived* (never a stored direction; ADR-0023):

- `REQUEST` — the owner is *called* in request/response (REST, RPC, a GraphQL field it serves);
  the caller depends on it, so the arrow points **at** the owner.
- `PUSH` — the owner *emits* unprompted (SSE, a webhook it sends, an event it publishes); the
  arrow points **away** from the owner.
- `SUBSCRIBE` — the owner *consumes* an external stream/feed; the arrow points **at** the owner.
- `DUPLEX` — the owner both sends and receives (a WebSocket); arrows at **both** ends.

It answers "from the owner's perspective, what is this interaction and which way does data
move?". A Connection renders the union of its routed Flows' arrows: none → a plain undirected
line, one direction → one arrowhead, both → arrowheads at both ends (a WebSocket is *one*
Connection, not two). The derivation rule lives in one place, `~/lib/flow-direction.ts`. The
word in prose and UI is **interaction**; the type name in code is `FlowInteraction` — the same
prose/type-name pattern **Component kind** / `NodeKind` uses. Never "direction" (it is derived,
not stored — re-introducing a stored direction or a `polarity`-on-edge field regresses ADR-0023).
`REQUEST`/`SUBSCRIBE` and `PUSH` are the arrow-preserving successors of the retired `INBOUND` /
`OUTBOUND` polarity; `SUBSCRIBE`/`DUPLEX` broaden a Flow from "a capability the owner exposes" to
"an interaction the owner participates in". *(Realized now as a per-Flow field, editable via
`addFlow`/`updateFlow`. `routeFlow` enforces only that the Flow's owner is an endpoint of the
Connection — there is no interaction-vs-arrow gate, so any owner-endpoint Flow routes onto the
single undirected Connection (ADR-0023, superseding ADR-0009/0013). The flow-derived arrowhead
rendering lands in a later slice of the same rollout.)*

### Component-detail panel
The slide-in surface that opens when a **Component** is selected on the **Canvas** — a sidebar,
not a modal, so panning and zooming continue behind it (performance). It hosts the Component's
**kind** row, its **FlowSpec** paste field, its **Flow palette**, and the markdown
**documentation** editor (ADR-0015). **Dual-audience:** the owner sees the full edit surface; a
**viewer** (a non-owner holding the capability slug) sees the *same panel read-only* — rendered
documentation (Plate `readOnly`) and the read-only Flow palette, with no kind picker, no paste
field, and no docs Edit toggle. The read-only affordances are *omitted, not disabled*, so the
viewer panel never signals an edit it cannot perform; read-only mode is presentation only — writes
remain owner-only at the service layer (ADR-0002). The word is **Component-detail panel** — never
"inspector", "sidebar" (names the layout, not the surface), or "properties panel". *(Realized now;
the read-only viewer variant landed with issue #16. See ADR-0002, ADR-0011, ADR-0015.)*

### Flow palette
The read-only UX surface listing a **Component**'s **Flows**. Surfaces on the
**Component-detail panel** that opens when the owner selects a Component on the **Canvas** —
alongside the paste field for its **FlowSpec** — and inside the **"+ flow"** popover that
opens when the owner selects a **Connection** (so the unrouted Flows on either endpoint are
pickable in place). Each item shows the Flow's `title`, `kind`, and `interaction`. When the
Component owns at least one Flow, its node body wears a **"N flows" pill** to signal the
palette is non-empty. *(Realized now on the Component-detail panel of a Component (editable for
the owner, read-only for a **viewer** — issue #16), inside the per-Connection "+ flow" popover,
and — since Slice 3 (#36) — on the **boundary
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
the *touches-endpoint* invariant, which is the WHOLE of `routeFlow`'s direction check: a
Connection is undirected, so any owner-endpoint Flow routes onto it and its **Interaction**
verb decides which way the derived arrow points (ADR-0023, retiring ADR-0013's
polarity-vs-arrow rejection and the reverse-Connection offer). De-dupe is `(outerEdgeId, flowId)` among active rows
— the **ADR-0010 named pattern**, third adopter (`idx_flow_route_dedup`, partial unique
backstop; service-primary `findFirst` is the readable fast path; both translate to
`ConflictError` with `details.conflictingFlowRouteIds`). The inner-Edge and FlowRoute writes
use `createMany({ skipDuplicates })` (`ON CONFLICT DO NOTHING`) so a concurrent racer never
aborts the route's transaction — convergence on a shared inner Edge, not a retry loop
(ADR-0012). *(Realized now for same-Canvas baseline routing via `routeFlow` / `unrouteFlow`,
surfaced as the `edgeFlows` aggregation in **getCanvas**, the routed-count pill on the
Connection, and the "+ flow" popover on a selected Connection — and, since Slice 3 (#36),
cross-scope refinement (the `innerEdgeId` writer) and palette rendering on **boundary
proxies**, with the drag-from-palette gesture. As of ADR-0023 a Connection is undirected:
`routeFlow` enforces only touches-endpoint, the per-Edge `arrowAtSource`/`arrowAtTarget`
aggregation in **getCanvas** drives the derived arrowheads, and the polarity gate +
reverse-Connection reconciliation (the old Slice 4 / ADR-0013) are retired. See ADR-0011
(Flow foundation), ADR-0012 (cross-scope writer), ADR-0023 (undirected Connection, derived
direction), and the master plan at `docs/plans/flow-routed-connections.md`.)*

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

### Markdown export
The byte-stable serialization of a **Project** — or one of its subtrees — to markdown for human
"Copy as markdown" use and the **MCP resources** (realized now via #18). Slug-readable on the web
path (ADR-0002, the same posture **getCanvas** uses) and owner-gated on the MCP path (ADR-0022),
with three modes:

- **Full project** (`canvasNodeId: null`, `mode: "full"`) — every **Component** in the Project,
  authored documentation included (heading-shifted), plus a **Connections** section.
- **Subtree** (`canvasNodeId: R`, `mode: "full"`) — R + descendants only, with a **Boundary
  context** section enumerating the externals incident to R on its parent **Canvas** so the
  export is self-describing (a deep slice is readable without re-walking up to the root).
- **Index** (`mode: "index"`) — a cheap structural map: titles, **Component kind**s, anchors,
  per-Component **Connection** counts; doc bodies omitted. The navigable view an indexing
  agent reads first.

Each Component carries an addressable HTML-style anchor `{#nodeId}`. Authored documentation is
**heading-shifted via an mdast AST walk** (`unist-util-visit` over `remark-parse`), never via
regex — a fenced code block containing a literal `#` line round-trips intact. Output is
**deterministic across runs AND OS locales**: ordering is **depth → title → id** computed in
application code with a Unicode codepoint comparator (`<`/`>`), never delegated to SQL collation
or `String#localeCompare` / `Intl` (those are banned in the serializer module). `remark-stringify`
options are pinned explicitly so a library version bump cannot silently re-baseline the byte
output. Locked by a golden-file byte-equality test that also mutates `LANG` / `LC_ALL` to prove
locale invariance. *(Realized now via two owner-resolving front doors over one shared fetch core
(`serializeProjectScope`) in `src/server/architecture/export.service.ts` — `exportMarkdown(db,
actor, input)` (slug-readable, web) and `exportMarkdownForActor(db, actor, input)` (owner-gated by
`projectId`, the MCP read path #18 / ADR-0022) — both depth-independent, honouring the
single-round-trip posture (ADR-0001), and both delegating to the pure `serializeGraph` in
`src/server/architecture/markdown.ts`. The "Copy as markdown" toolbar action and the breadcrumb-bar
scope-anchored copy ship the client-side surface. **Flow** / **FlowRoute** sections are out of scope
here — Slice 5 / #38 extends the format additively (`### Flows` Component subsection, `flows:`
Connection subsection) without re-baselining the #15 golden file. See ADR-0017.)*

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
