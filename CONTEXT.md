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

| Concept                         | User-facing term (docs, UI, MCP verbs) | Data-model / graph-code term                |
| ------------------------------- | -------------------------------------- | ------------------------------------------- |
| A documented thing on the graph | **Component**                          | **Node**                                    |
| A link between two of them      | **Connection**                         | **Edge**                                    |
| A Component's connection point  | **Port** (input / output)              | **handle** (React Flow `target` / `source`) |

Rule of thumb: anything a human reads or an MCP agent calls says **Component** / **Connection** /
**Port**; anything in the Prisma schema, React Flow code, or graph algorithms says **Node** /
**Edge** / **handle**.

**Exception — some terms have no user/code split.** Unlike Component/Node and Connection/Edge,
a few terms — **Interaction** / `Interaction` (a **Connection** attribute), **Spec** / `Spec` —
use the same word in user-facing and code surfaces. The split exists because "Node" collides
with Node.js and the canvas library's node primitive; these words carry no such overload (React
Flow names the _library_, not a graph primitive we model), and users genuinely say "interaction"
/ "spec" when they mean the same thing engineers do. The discipline is not weakened; the
conditions that motivated it do not apply here. When a future term arrives, default to applying
the split; deviate only when both conditions hold — the word is the natural user word AND it
carries no overload pressure. _(The retired **Flow** / **FlowSpec** / **FlowRoute** vocabulary
formerly rode this exception — see those tombstones.)_

## Terms

### Component

The user-facing unit of architecture you place, name, document, and open — a host, database,
external API, service, module, table, or anything else worth describing. Carries markdown
documentation, edited in the **Component-detail panel** through a WYSIWYG editor that renders
the markdown formatted and toggles to an editable surface with debounced, optimistic autosave
(no save button; the stored markdown string is the source of truth — ADR-0015). Backed by a
**Node** in the data model. Components nest: opening one reveals its interior **Canvas**.
_(The graph data model and nesting land in a later milestone; the term is canonical now.)_

### Node

The data-model representation of a Component: the stored graph vertex with
`parentId` (its containing Component, or null at the **Project** root), plus
`kind` (see **Component kind**), position (`posX`, `posY`), `documentation`, the
generated-component provenance columns `sourceSpecId` + `specKey` (set when a
Component is derived from a **Spec** — the generation that populates them is #64;
#62 lands only the columns and their cascade), and a soft-delete column
(`deletedAt`). Never surfaced to users by this name.
_(The `Node` model and the operations on it — `createNode` (root or child under
a validated parent), `getCanvas` (with **breadcrumbs**), `updateNode` (title
only), `updateNodeDocumentation` (the narrow owner-only autosave feeding the
detail-panel markdown editor — ADR-0015), `updatePositions` (batched on
drag-stop), `upsertBoundaryProxyPlacement` (the single owner-only write that
persists where a **boundary proxy** sits on one scope's **Canvas**, keyed by
`(containerNodeId, realEndpointId)` — #91 / ADR-0036), `moveNode` (reparent to a
new Canvas scope; cycle-creating moves
reject as `ValidationError` — the orphan-reject is retired now that Connections
may span scopes, so a reparent never strands an incident Connection, ADR-0024 as
amended by #62), and the cascading `deleteNode` / `restoreNode` pair (see
**Deletion id**) — are realized now. `moveNode` ships via the MCP
`move_component` **MCP tool** (#19); the web/tRPC reparent surface is later
work. **Connection**/**Edge** wiring is its own entry.)_

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
**Component-detail panel**'s Kind row), never slug-granted (ADR-0002). _(The
expanded enum, the **kind palette** picker, **kind affinity** ranking, and
`updateNodeKind` are all realized now. Further kinds remain an additive change.
See ADR-0018, ADR-0019.)_

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
constraint exists). _(Realized now alongside the **kind palette**. See ADR-0019.)_

### Kind palette

The Command-palette UX surface for picking a **Component kind** — a searchable,
keyboard-navigable list (built on the shadcn/`cmdk` `Command` primitive) that
replaced the original `<select>` dropdown. Renders the full `NodeKind` set with
the **kind-affine** entries grouped under a "Suggested" heading above a separator
and the remainder under "All kinds" below, preserving the invariant that every
kind is always reachable (search spans both groups). It is the only
kind-selection surface in the canvas: the "Add Component" control opens it, and —
since Slice 2 — the **Component-detail panel** reopens the same palette to change
a Component's kind. That control and the **Connect-to** palette both mount their
popover through the shared Base UI wrapper at `src/components/ui/popover.tsx`,
which portals out of the panel's `overflow` clip with collision-aware
positioning (#89) — the canonical popover host, mirroring the `dialog.tsx` /
`command.tsx` vendor-a-minimal-subset convention. Follows the _palette_
convention — the word names the
surface, not the library (cf. the **Command-palette** primitive it is built on).
Never "kind picker" (too generic —
it could name a `<select>`), "command palette" (collides with the library term),
or "kind selector". _(Realized now; the `<select>` it replaces is retired. The
canonical-command-palette ADR is deferred until a second palette adopter, per
docs-travel-with-code-slices.)_

### Connection

The user-facing link between two Components, drawn on a **Canvas** by dragging between their
**Ports** (in either direction — Ports are non-directional). Carries an optional **label**
(untrusted user content — stored verbatim, never interpreted; see the prompt-injection standing
note). Backed by an **Edge**. A Connection is a **directed, typed edge** that may link **any two
Components at any scope** — same-Canvas, cross-scope, or **lineal** (an ancestor and a
descendant; a parent→child Connection expresses **ingress**). It carries its own **Interaction**
(default `ASSOCIATION` — a plain undirected line with no arrowheads); the four directional
interactions (`REQUEST`/`PUSH`/`SUBSCRIBE`/`DUPLEX`) live ON the Connection rather than being
derived from routed traffic. Drawing order (`source`/`target`) is preserved, and arrowheads are
derived from `(interaction, source, target)` — a WebSocket is ONE Connection (`DUPLEX`), not two
(ADR-0027). The only endpoint the service rejects is the **true self-link** (A === B);
cross-scope and lineal endpoints are accepted (ADR-0028, retiring the same-Canvas invariant of
ADR-0005). _(Drawing, labeling, and removing a Connection are realized now — see **Edge** for the
self-link, cross-scope/lineal, and no-duplicate-active rules. A Connection's `interaction` is set
at creation (`connectNodes`) and defaults to `ASSOCIATION`. **Cross-scope read** — surfacing the
Connections relevant to a scope with each end resolved to a real Component or a **boundary proxy**
— is realized now via **getCanvas** (#63 / ADR-0031). **Arrowhead rendering from `interaction`
(via the canonical `~/lib/connection-direction` helper) and the client rendering of cross-scope
Connections — the far end shown as a boundary proxy — are realized now (#65 / ADR-0027). The
interaction is editable after creation through the picker on the selected Connection
(`updateEdgeInteraction`). Drawing a Connection across scopes is realized now via the project-wide
"Connect to…" search (#66 / ADR-0032): the owner picks the selected Component's far end from a
searchable list of every Component at any depth, the Connection is created `ASSOCIATION` by default
(its interaction set afterward via the picker), and the far-end boundary proxy is inserted
optimistically and reconciled on success. A Component's complete incident Connections — across all
scopes — are listed in the Component-detail panel's Connections section (`listNodeConnections`); the
project-wide search is backed by `listProjectComponents`.**)_

### Edge

The data-model representation of a **Connection**: the stored graph edge with `sourceId` and
`targetId` (both **Nodes**), an `interaction` (`Interaction`, default `ASSOCIATION`), an optional
`label`, and a soft-delete column (`deletedAt`). **An Edge stores no scope** — there is no
`canvasNodeId` column; an Edge's scope is _derived from its endpoints' ancestry_ at read time
(the **getCanvas** derivation, ADR-0031), so an Edge may freely span scope levels. `sourceId`/`targetId`
preserve **draw order**, and arrowheads are derived from `(interaction, source, target)` at
render time (#65); the pair is not a stored `direction` field. Two invariants hold and are
enforced **in the service, not the database** (ADR-0028, retiring ADR-0005's same-Canvas
invariant): an Edge never links a Node to itself (the **true self-link**,
`sourceId === targetId`), and no two _active_ (non-soft-deleted) Edges duplicate per the de-dupe
rule below. **Cross-scope and lineal** (ancestor↔descendant) endpoints are accepted;
`connectNodes` is the writer and there is no longer a gated cross-scope exception (the `routeFlow`
inner-Edge writer is deleted with the Flow model).

**De-dupe is now two partial unique indexes** (ADR-0010 named pattern, re-keyed because scope is
no longer stored): a **directional** index over the ordered tuple
`(projectId, sourceId, targetId, interaction)` for the four directional interactions, and an
**`ASSOCIATION`-only unordered** index over `(projectId, LEAST(sourceId, targetId),
GREATEST(sourceId, targetId))` (`A↔B` and `B↔A` are one Association). Both are
`WHERE "deletedAt" IS NULL`; `interaction` is in the directional key (so `A→B REQUEST` and
`A→B PUSH` coexist) but **`label` is not** (re-labeling edits the existing Connection).
Service-primary `findFirst` with the index as backstop, both translating to `ConflictError`.

**Spec-derived Connection provenance** (#76, ADR-0033): an Edge carries optional `sourceSpecId` +
`specKey` (the Edge analogue of the **Node** provenance columns), set when a Connection is
materialized from a **Spec** — today, a foreign key in a SQL DDL Spec. Both null for a hand-drawn
Connection. They let a re-parse _reconcile_ the Connections a Spec owns (draw new FKs, drop vanished
ones, refresh changed ones) without disturbing user-drawn Connections. One Connection is drawn per
ordered table pair (multiple FKs between the same pair merge into one `REQUEST` arrow whose label
lists the columns; a self-referential FK is skipped — no self-link). When an FK would occupy a slot
a hand-drawn Connection already holds, that Edge is _adopted_ (stamped with the Spec's provenance)
rather than duplicated.

Never surfaced to users by this name. _(The `Edge` model with `interaction`, `connectNodes`
(cross-scope + typed) / `updateEdge` / `deleteEdge`, and the **getCanvas** `interiorEdges` read
are realized now; Connection removal as part of a Component delete is undoable now (see **Deletion
id**). `deleteEdge` is a plain lone soft-delete (no cascade — the FlowRoute cascade is gone). The
two partial unique indexes land via the #62 migration (ADR-0010 pattern). The cross-scope **read**
of an Edge whose endpoints span scopes is realized now via **getCanvas**, which resolves each
endpoint to its on-scope representative or a **boundary proxy** of the off-scope end, derived from
endpoint ancestry (ADR-0031); cross-scope client rendering and the interaction-derived arrowheads
are realized now (#65). `updateEdgeInteraction` edits the `interaction` of an existing Edge and
re-checks the directional de-dupe key, so an upgrade that would duplicate an active Edge is
rejected as a `ConflictError`.)_

### Port

A Component's connection point — the user-facing name for a React Flow **handle**.
**Non-directional** (ADR-0023): a Component is not directional, so a Port carries no
input/output role. Every Component exposes two (rendered left and right) purely for
drag-discoverability; under React Flow's `ConnectionMode.Loose` either can start _or_ end a
**Connection**, in either direction. Which way a Connection is drawn is _preserved_ as
`source`/`target` and feeds the derived arrowheads together with the Connection's **Interaction**
(see **Connection**, **Interaction**); the Port a drag starts from carries no input/output role.
Both Ports are **unbounded**: a Port can feed many Connections and receive from many (fan-out
and fan-in), with no connection-count cap; the only limit is the de-dupe rule (see **Edge** —
directional rows de-dupe on `(projectId, source, target, interaction)`, `ASSOCIATION` rows on the
unordered pair). The word in prose and UI is **Port**; the React Flow code word is **handle** (the
same user-vs-code split as Component/Node) — never "connector", "socket", "anchor", or "terminal".
_(The two non-directional handles render on every Component now; the former input/output
framing retired with ADR-0023 and stays retired under ADR-0027. Typed, named, or per-protocol
Ports remain out of scope.)_

### Edge direction — retired (thrice)

A _stored_ arrow direction has never lived on the Edge. It was first a cosmetic `EdgeDirection`
enum (`NONE` / `FORWARD` / `BIDIRECTIONAL`) the user cycled by hand (removed by ADR-0009, which
made the arrow _structural_ — derived from the `sourceId`→`targetId` ordering). ADR-0023 removed
even that structural meaning, deriving arrows from the **Flows** routed on a Connection. ADR-0027
retires the Flow-derivation in turn: a Connection now carries its own **Interaction**, and
arrowheads are derived from `(interaction, source, target)` — `source`/`target` preserve draw
order but are not themselves a direction field, and `interaction` is a _type_, not a stored arrow.
Re-introducing a stored `direction` (or a `polarity`-on-Edge) field regresses all three ADRs.
Note draw order is now **preserved** (not arbitrary): it feeds the directional de-dupe key and the
derived arrow. See **Connection**,
**Port**, **Interaction**, and ADR-0027.

### Canvas

A **derived view, not a stored entity.** The Canvas of a Component `N` is
`{ Nodes where parentId = N } ∪ { Edges whose BOTH endpoints have parentId = N }` — an Edge no
longer stores its scope (`canvasNodeId` is dropped; ADR-0028), so the same-Canvas Connections fall
out of endpoint ancestry, not a stored column. The Project root has its own top-level Canvas (the
Nodes with `parentId = null`). Because it is derived, a Canvas is never written directly — you
mutate Nodes and Edges, and the Canvas falls out. The full derived Canvas of `N` is
`{ Nodes where parentId = N } ∪ { Edges resolved to this scope } ∪ { boundary-proxy stand-ins for
the off-scope end of each Edge crossing this scope }`, where an Edge resolves via its endpoints'
ancestry (ADR-0031). _(The Node half of the derivation is realized now via **getCanvas**, and the
Edge half — same-Canvas, altitude, and cross-scope — is realized now too; reading a non-root scope
is realized now via **getCanvas**, and user-facing navigation into it is realized now via
**Descent**. Client rendering of the cross-scope Edges and proxies is realized now (#65).)_

On a hub-dense Canvas the **active** Connection — the one hovered or selected — lifts its label
clear of its neighbours and shows the full untruncated text in place, while every other label
recedes (dims and blurs) so the focused one reads; the interaction picker for a selected Connection
floats in a **popover** off the bezier midpoint rather than piling onto it. Label layering is plain
CSS `z-index` within the single shared label portal, **not** React Flow's edge `zIndex` (which
raises the SVG edge group, not the label). Several Connections between the **same node pair** (e.g.
`A→B REQUEST` and `A→B PUSH`, or many crossing edges coalesced onto one boundary proxy) share one
path and would stack their labels invisibly — so they collapse into a single **group chip** (the
distinct interaction glyphs present, plus a count) that opens an on-demand list of every Connection;
selecting a row focuses that Connection and shows its normal label + picker. Presentation-only — no
Edge, Connection, or Interaction data changes (ADR-0039).

### getCanvas

The single service read that materializes a **Canvas** for a given **Canvas
scope** in one round trip. Its result is
`{ interiorNodes, interiorEdges, boundaryProxies, breadcrumbs }`,
derived without a per-level query walk. Because a Canvas is a _derived view_,
`getCanvas` returns the **Nodes** and **Edges** that fall out of the scope —
it is the read half of the Component/Node split, so its result is named in
**Node**/**Edge** terms in code and tests even though the feature is described
to users as "the interior **Components**". `interiorNodes` are the Nodes whose
`parentId` is the scope. Each `interiorEdges` row is `{ id, sourceId, targetId,
sourceRepr, targetRepr, interaction, label }`, where `sourceRepr` / `targetRepr`
resolve each endpoint to its **on-scope representative** — the real Node when the
endpoint is interior, an ancestor for the altitude view, or a **boundary proxy**'s
synthetic id when the endpoint is off-scope. Each `boundaryProxies` row is
`{ nodeId, title, kind, realEndpointId, edgeId }`, **one per crossing Edge** (never
de-duped per far Node). The whole edge-and-proxy derivation is ONE recursive
ancestry CTE — for scope `S` and Edge `E=(A,B)`, with `rep(N,S)` the ancestor of
`N` whose parent is `S`: both reps present and distinct → an interior edge; exactly
one present → an interior edge to a boundary proxy of the off-scope end; both equal
or neither present → not rendered (no stored Edge scope; ADR-0028, ADR-0031). _(Realized
now — `getCanvas` returns `interiorNodes`, `interiorEdges`, `boundaryProxies`, and
`breadcrumbs` for a scope. A non-null scope that resolves to no live Node in the
Project is a not-found; a connection-ancestry walk clipped by the depth cap is a
loud `ValidationError`, distinct from the breadcrumb-truncation one. See ADR-0001
for the single-round-trip service contract, ADR-0004 for how the payload reaches the
client island, ADR-0006 for the recursive-CTE / raw-SQL discipline both derived
reads share, and ADR-0031 for the cross-scope derivation. Client rendering of the
cross-scope Edges, the proxies, and the interaction-derived arrows is realized now (#65).)_

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
and do not call it a "level", "context", or "view". _(The root scope and reading
at non-root scopes are realized now via **getCanvas**; user-facing navigation into
non-root scopes is realized now via **Descent**.)_

### Scope path / `via`

The **crossing stack** identifying a **Canvas scope** reached through one or more **portals** — an
ordered list of portal **Node** ids crossed, **host-first**. **getCanvas** takes it as `embedPath`;
the **Project route** carries it as a typed `?via=` query param, so an embedded scope stays under
the **host** Project's slug and the **embedded project**'s slug never appears. It is an
**inter-project routing fact**, **not** ancestry — intra-project ancestors stay server-derived
(ADR-0007 is not regressed). The chain is **wholly untrusted**: each entry is **re-gated per-actor**
(`resolveReadableProjectById`, `none → not-found`), and a forged or stale `via` collapses to
not-found. Authorization **gates once per project segment crossed** (not once per request). Distinct
from the reserved **`Actor.via`** (`"session" | "token"`, ADR-0021/0040), which records _how_ an
actor authenticated and **never decides authz**: `?via=` is an untrusted routing input that is
verified at every step, `Actor.via` is an inert provenance label. _(Realized now read-only via
**Descent** across a portal. #119, ADR-0041, ADR-0007.)_

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
and marks the last entry as the current scope (ADR-0007). _(Realized now
end-to-end: computed in the data layer and rendered by the Descent breadcrumb bar.)_ Across a
**portal** the trail is a **per-segment concatenation** — each project segment computes its own
ADR-0006 CTE, spliced at the portal marker — never a cross-project CTE (a `parentId` walk cannot
cross a project boundary; #119, ADR-0041).

### Descent

The act of opening a Component to enter its interior **Canvas**, moving one level deeper into
the graph. Recurses to any depth. _(Realized now: double-clicking a Component descends into its
interior **Canvas** at the **Project route** `/p/[slug]/n/[nodeId]`, with hover prefetch so the
descent feels instant. See ADR-0007.)_ Descent may **cross a project boundary**: opening a
**portal** descends into its **embedded project** rather than a `parentId` child — the one Descent
that **leaves the host graph**. The crossing is recorded in the **scope path** (`?via=`) and
**re-gated per-actor** (`resolveReadableProjectById`, not-found on denial); the URL stays under the
host slug, exploration is **read-only in this slice**, and the breadcrumb spine spans the boundary
(host trail → portal marker → foreign trail). _(#119, ADR-0041.)_

### Boundary proxy

The on-canvas read-only stand-in for the **off-scope endpoint** of a **Connection** that crosses
this scope. When **getCanvas** surfaces an Edge with exactly one endpoint resolving onto the scope
(see **getCanvas**'s `rep(N,S)` rule), the other end renders as a boundary proxy of the real far
endpoint — the real Node it stands in for is carried as `realEndpointId`. Boundary proxies are
**derived per crossing edge**, never inherited or projected transitively: a Component reached as
the far endpoint of three crossing Connections produces three `boundaryProxies` rows that share
`realEndpointId` but each carry a distinct synthetic `nodeId` (`proxy_<edgeId>`), so it stays
addressable by the edge that produced it and React Flow keys never collide. On the Canvas these
per-edge rows are **coalesced at render** — rows sharing a `realEndpointId` draw as one node with
all crossing Connections routed to it (#90) — a view-only collapse that never touches the per-edge
rows, the cache mirror, or the Connections list. The proxy's **identity is fully derived** — it
persists no row of its own (ADR-0031); the only thing persisted is an adjunct **placement** (where
it sits on this scope's Canvas), kept in the separate `BoundaryProxyPlacement` table and joined back
at read time (#91 / ADR-0036, below). Each derived row is `{ nodeId, title, kind, realEndpointId,
edgeId, posX, posY }` — the first five fields are the **frozen derived identity** (ADR-0031); `posX`
/ `posY` are **additive, nullable** — the persisted view coordinate for this scope's proxy of
`realEndpointId` (the coalesced key, so every per-edge row sharing it gets the same coordinate),
`null` until the proxy is first dragged on this scope (the client then falls back to the off-scope
left rail). Still **no `origin`, no `direct`/`inherited` partition, no transitive walk** (that whole
framing died with the Flow model; ADR-0031 supersedes the boundary halves of ADR-0012/0016). A
boundary proxy is a **passive node** — read-only everywhere except that an **editor may drag it** to
persist its per-scope placement (the one passive-drag exception, #91 / ADR-0036); no
Component-detail panel, no Descent, no hover-prefetch, never selectable/connectable/deletable. The
drag/seed/persist key is always `realEndpointId`, never the per-edge `proxy_<edgeId>` view id. The
code term is **boundary-proxy**.
Never frame it as an "external" or "inherited" node — the system has no external Nodes, only
off-scope ones. *(The cross-scope read is realized now via **getCanvas** (#63 / ADR-0031); client
rendering of the proxy — as a passive node with a *go to real endpoint* affordance (navigating to
the off-scope Component's own scope) — and the arrowheads on its incident Connection are realized
now (#65). A proxy whose real endpoint is an ancestor of the current scope (the lineal/ingress
case) is labelled as an inbound boundary so it does not read as the host inside itself. The
markdown export's subtree **Boundary context** section adopts the same per-edge posture (#67 /
ADR-0017 amendment): ONE row per crossing Connection, far endpoint named with its `{#nodeId}`
anchor, no `direct/inherited` partition — derived independently from `getCanvas` (one walks
descendants under a subtree root, the other walks whole-Project ancestry; ADR-0031 sanctions the
two derivations stay separate).)*

### Boundary endpoint

Retired (#62): with no cross-scope **FlowRoute** and no `routeFlow` writer, there is no "one
endpoint allowed to violate same-Canvas" concept — _all_ endpoints may now span scope (ADR-0028).
The far-end stand-in that replaces it is the **boundary proxy** (ADR-0031).

### Boundary group

Retired (#62): the client no longer renders the transitive inherited-proxy _data_ group — the
`origin: direct/inherited` partition and its container are gone (ADR-0031 supersedes ADR-0016's
boundary halves). Distinct from that retired structure, #90 adds a purely **render-time**
coalescing — per-edge proxy rows sharing a `realEndpointId` draw as one node — which introduces no
data grouping, no `origin` field, and no persisted rows. Historical: ADR-0016.

### Passive node

A derived, read-only React Flow node on a **Canvas** — the **boundary proxy** —
excluded from the three interactive surfaces a **Component** participates in: the
**Component-detail panel** (no editable record exists), **Descent** (no interior **Canvas scope**
to open into), and hover-prefetch (nothing to warm). Passive nodes carry no **Node** row, are
never `selectable`, `connectable`, or `deletable`, and are partitioned out of every interactive
_pointer_ handler by a single discriminator so a new passive kind composes by extension rather than
by sprinkling fresh guards through the click / double-click / hover paths (ADR-0016). The one
interactive exception is **drag**: the **boundary proxy** is draggable for an **editor** so its
per-scope **placement** persists (#91 / ADR-0036) — it inherits the Canvas's `nodesDraggable=canEdit`
(so a **viewer** still cannot drag it) rather than pinning `draggable:false`, and `onNodeDragStop`
is the sole interactive handler it participates in. The term is
**passive** — not "read-only" (which is overloaded with the capability-URL viewer surface,
owner-edit vs viewer-read) and not "non-interactive" (which over-claims — passive nodes still
expand and collapse their own internals; they are inert _with respect to the Canvas's interactive
surfaces_, not globally inert). _(The **boundary proxy** is the sole passive kind today, re-derived
by **getCanvas** per crossing edge (#63 / ADR-0031); its client rendering as a passive node — the
`boundary-proxy` React Flow node type, recognized by the `isPassiveNode(CanvasRFNode)` discriminator
— is realized now (#65). Additional passive kinds compose by extension via the same discriminator,
ADR-0016.)_

### Project

The root container of one architecture graph. Owned by a single user (`ownerId`) and addressed
by a unique, unguessable **capability-URL slug**. Also carries **Member**s (delegated **Role**s), a
**guest access** level (`guestAccess`, default `VIEW`), and **Invite**s (ADR-0040). Holds the
top-level **Canvas** and everything that descends from it. Soft-deletable (`deletedAt`). The first
concrete model in the system. The owner deletes one from the dashboard via a
**type-the-title-to-confirm** dialog; `deleteProject` is an **owner-only** **lone soft-delete**
(resolve by slug → `requireCapability(cap, "owner")` → stamp `deletedAt`, no `deletionId` and no
cascade — children keep their rows and simply stop resolving once the Project is hidden), mirroring
`deleteEdge`. A non-owner ADMIN cannot delete. The typed-title match is a client-side friction gate
only; the real authorization is the `owner`-rank gate (ADR-0001, ADR-0040).

### Portal

A **Component** that embeds another whole **Project** as a **live pointer**. Backed by a nullable
`Node.embeddedProjectId` FK to `Project.id` (`onDelete: SetNull`, indexed); the **presence of the
FK is the sole discriminator** — a portal keeps an ordinary cosmetic **kind** and is **never** a
`NodeKind` value (a portal is _behavioral_, kind is cosmetic; ADR-0018 / ADR-0041), mirroring the
`sourceSpecId` provenance FK (ADR-0033). A live pointer, **not a snapshot** — the target is read
live at descent, no copied subtree (the derived-not-stored posture of **Canvas** / **boundary
proxy** / **Trace**). Creating one requires **edit** on the host **and** **≥ view** on the target
(you may embed only what you can read); self-embed is rejected (`ValidationError`); the embed stack
is depth-capped at `ANCESTRY_DEPTH_CAP` (256). Deleting the **target** nulls the FK and the portal
**neutralizes** to a plain Component — degrade, never cascade into the host, never block the
target's deletion. Never a "link" (that is a **Connection**) and never a "PORTAL kind". The
"Embed a project" picker offers **any project the actor holds ≥ view on** (`listProjectsForActor`,
excluding the current project) — owned **and** shared — since the create gate (host **edit**, then
target **≥ view**) already permits embedding anything you can read; on the host read a portal
resolves a **Portal access state** (enterable / read-only / locked) per-actor. _(Realized now: the
per-actor re-gate and shared-target embedding both ship. #120, #119, ADR-0041.)_

### Embedded project

The target **Project** a **portal** points at. Addressed **only** by internal `Project.id` via
`embeddedProjectId`; its **capability-URL slug is NEVER exposed** (a bearer secret, ADR-0002) — not
in the path, the `?via=` query, any response, breadcrumb, or log. Its read is **re-gated
per-actor** through `resolveReadableProjectById` (the id-keyed read corner, sharing the one
`resolveCapability` spine; ADR-0040), honoring the target's own **guest access** and mapping a
sub-`view` capability to **not-found**. The **host's capability never governs the target** — a host
owner with no grant on the target sees a **locked portal**. On **descent** that denial is
indistinguishable from a missing scope (`none → not-found`); on the **host Canvas read** the same
denial instead surfaces a **non-disclosing locked sentinel** — the host **Node** exists and is
acknowledged, but the embedded project's **title and id are withheld** ("two seams, one denial",
see **Portal access state**). Never a "linked" or "child" Project. _(#120, ADR-0041, ADR-0040.)_

### Portal access state

The per-actor state a **portal** resolves to on the **host Canvas read** — three tiers off the
capability ladder (ADR-0040), resolved against the **embedded project** for the **descending actor**
via `resolveReadableProjectById`. The **host's** capability **never** governs which tier; only the
descending actor's capability **on the target** does.

- **enterable** (target capability ≥ **edit**) — descends; the view-vs-edit write split is **#121**.
- **read-only** (target capability = **view**) — descends into a **read-only foreign scope**; the
  existing **viewer** affordance-suppression applies (`canEdit = false`), no new write code.
- **locked** (target capability **none**) — non-descending, greyed "No access" **LOCKED SENTINEL**.
  The host **Node** legitimately exists and is **host-owned**, so this is **not** **NotFound** — the
  host read **acknowledges the node** while **withholding the embedded project's identity** (its
  title **and** its `Project.id`; the stored title captured at embed time is replaced server-side
  with a neutral "Locked project" label). Existence of the host node is the **discloseable** thing;
  the foreign identity is **withheld** — non-disclosure at the right granularity (ADR-0002 /
  ADR-0040 / ADR-0041).

Resolved **per-actor on every host read**, **never stored** — a **live pointer**, so a grant or
revoke flips the state on the next read. _(#120, ADR-0041, ADR-0040.)_

### Capability URL / slug

An unguessable, per-Project URL segment (`slug @unique`) that, by mere possession, grants
**read** access to that Project — no sign-in required — **when the Project's guest access is `VIEW`**
(the default). It is a bearer capability: the link _is_ the permission. `guestAccess = NONE` closes
anonymous reads, so the slug alone then resolves a not-found and reads require a **Member**
(ADR-0040). **Mutations are never granted by the slug**; writes require the signed-in owner or an
EDITOR+ **Member**. A non-owner who holds the slug (at guest `VIEW`) is a **viewer** — the canonical
term for this person in prose, code (`canEdit = false`), and UI ("View only"); never "visitor" or
"guest" (the latter names the _access level_, not the person). The web client presents a **read-only
mode** to a viewer
(every edit affordance hidden, a read-only **Component-detail panel**, a "View only" header
badge), but that mode is _presentation, not authorization_: every mutation is still denied at the
service layer regardless of what the client renders (issue #16). The slug is one of the system's
**three** bearer secrets — the **API token** and the **Invite** are the others (the slug grants
link-based _read_ to one Project; an API token grants an agent the minting user's access over the
MCP path; an Invite grants a **Role** on redemption); all are treated as secrets in logs.
_(See ADR-0002, ADR-0020, ADR-0040.)_

### Project route

The web address at which a Project opens — its **capability-URL slug** as a path segment —
landing on the Project's top-level **Canvas**. The route is a server component that resolves the
Project by slug (read access per ADR-0002), so it is reachable without sign-in; the **Canvas** is
mounted beneath it as a client-only island (ADR-0004). A missing or soft-deleted slug renders an
indistinguishable not-found. Interior Canvases hang off the same path at
`/p/[slug]/n/[nodeId]`, where `[nodeId]` is the scope's opaque **Node** id — URL addressing, not
prose, so it sits outside the Component/Node naming split (like the `slug` itself), and the
bearer-slug response headers cover it via the `/p/:path*` matcher (ADR-0007). _(Both the top-level
Canvas route and — via **Descent** — interior Canvas routing are realized now.)_

### Actor

The resolved identity of whoever is calling a service function:
`{ userId, scopes?, via?: "session" | "token" }`. Constructed at the edge (a tRPC procedure
resolves it from the session; the **MCP path** resolves it from a token via `resolveActorFromToken`
— realized now, #18) and passed as the second argument to **every** service function. Authorization
is derived **only** from `userId` — now: the userId's effective **capability** on the Project,
resolved by **access** over owner identity + **Member**ship (ADR-0040); `via`/`scopes` are never
used to make an authz decision. _(See ADR-0001, ADR-0022, ADR-0040.)_

### Service layer

The single deep module that is the **only** home for business logic and authorization. Every
operation is a plain function with the signature `(db, actor, input) => result`:
`db` is the Prisma client (the injectable seam), `actor` is the resolved caller, `input` is
validated data. tRPC routers and the MCP server are thin adapters that resolve an Actor
and call into this layer. Authorization lives here — **not** in the tRPC guard — because the MCP
path does not pass through that guard. _(See ADR-0001 and ADR-0003.)_

### access (module)

The single home, inside the service layer, for authorization predicates. Its core is the
**capability ladder** (ADR-0040): `resolveCapability` (pure, in `access.ts`) resolves a caller's
effective rank on `none < view < edit < admin < owner` from owner identity, **Member**ship
**Role**, and **guest access**, and `requireCapability(cap, min)` gates it. Every service function
routes its authorization decision through this module so the policy lives in exactly one place. The
DB-aware read/write seams live in `access-db.ts`: reads gate on _view_ (a denial maps to
_not-found_, never forbidden — non-disclosure); writes gate on _edit_/_admin_/_owner_ (a denial is
_forbidden_). As of #109 the **MCP** read paths resolve through this same ladder too (owner **or**
member, `guestAccess` forced **NONE** so a token never inherits the public guest grant) — there is
one read-authz spine, not two. The only owner-only predicate that remains is `assertCanWrite`,
retained solely for **API token** management (a token is a personal credential minted/listed/revoked
by its owner alone, not a project resource on the ladder); its `OwnedResource { ownerId }` shape is
**structural**, not Project-coupled — it authorizes over any row whose owning identity is
`ownerId`/`userId` (an **API token**'s `userId` feeds it directly). _(See ADR-0001, ADR-0002,
ADR-0022, ADR-0040.)_

### Member

A **User** granted a **Role** on a **Project** via a `ProjectMembership` row
(`{ projectId, userId, role }`, unique on `(projectId, userId)`). A Member is _not_ the
**owner** — the owner is the irrevocable root of trust resolved by identity (`project.ownerId`,
ADR-0002), never a membership row, so no access-management operation can revoke or downgrade it
and none is auto-inserted. Membership is how the owner (or an ADMIN) **delegates** a capability
below their own; no member can grant a capability they do not hold, and none can act on the owner.
A Member's capability is resolved by **access** to a rank on the capability ladder and compared
`rank >= required` at every gate. Never "collaborator" or "user-of-the-project" in code — the row
is a `ProjectMembership` and the person is a **Member**. Distinct from **viewer**: _viewer_ is the
read-only presentation mode (capability _view_, from a guest slug **or** a VIEWER membership),
_Member_ is the persisted-row concept. _(See ADR-0040, ADR-0002, ADR-0001.)_

### Role

The named, persisted level a **Member** holds on a **Project** — one of `VIEWER`, `EDITOR`,
`ADMIN` (`ProjectRole`). Each maps onto the capability ladder: `VIEWER` → _view_ (read +
**descend**), `EDITOR` → _view_ + _edit_ (mutate the graph), `ADMIN` → _edit_ + **manage access**
(invite, change roles, set **guest access**) yet still strictly below _owner_ — an ADMIN cannot
delete or transfer the Project nor touch the owner. `Role` is the three-value wire/DB vocabulary
humans are assigned to; the integer **rank** on the ladder (`none < view < edit < admin < owner`)
is the internal total order **access** actually compares. There is no assignable `OWNER` or `NONE`
role — owner is identity, "none" is the absence of a grant. The word is **Role** in prose, UI, and
code — never "permission" (over-claims; the enforced thing is the rank) and never conflated with
**token scopes** (a different axis — stored-not-enforced, ADR-0021). _(See ADR-0040, ADR-0021.)_

### Guest access

A per-**Project** dial (`GuestAccess`) setting the capability granted to an _anonymous_ holder of
the **capability-URL slug** — `NONE` (no anonymous access; the slug alone resolves not-found) or
`VIEW` (anonymous read + **descend**). `VIEW` is the **default** (a `NOT NULL DEFAULT 'VIEW'`
backfill) and reproduces ADR-0002 exactly: the slug-possession read grant, the **viewer** read-only
surfaces, and the "View only" badge (issue #16) are all what a guest at `VIEW` sees — roles **layer
atop** the capability-URL model, they do not replace it. `NONE` is the opt-in "members only"
lockdown that closes anonymous reads without rotating the slug (slug rotation remains the separate
answer to _disclosure_, ADR-0002). Guest access never exceeds _view_; the slug is **never** a write
grant. "guest" names the anonymous-slug _access level_, never the _person_ (who is still a
**viewer**). This is the **slug-keyed read seam** — it may run with no **Actor** at all.
_(See ADR-0040, ADR-0002.)_

### Invite

A bearer link (`ProjectInvite`) that grants a **Role** to whoever redeems it while signed in,
creating or upgrading their **Member**ship. The system's **third bearer secret** after the
**capability-URL slug** and the **API token**, and it inherits the API token's storage posture
wholesale (ADR-0020): raw token is CSPRNG entropy **shown once**, stored only as a **keyed HMAC**
under the same **token pepper** (no per-row salt, so redemption is a lookup-by-hash), with a
non-secret prefix, an expiry, and soft revocation. Project-scoped (no `userId` — consumed by
_whoever_ redeems it). An Invite carries a `Role`, never a raw rank, and **never `owner`** — you
cannot invite someone to own a Project. A `maxUses` cap (null = unlimited) bounds how many times it
can be redeemed; each real grant increments `useCount`, and an exhausted (**maxed-out**) Invite stops
granting. Unlike the slug (possession _is_ a read grant), an Invite grants nothing until **redeemed**
into a membership, so revoking the link or the membership cleanly removes access. To **redeem** (the
verb in prose; `claimInvite` in code, the route `/i/[token]`) is to consume an Invite into a Member —
atomic, idempotent, race-safe, and **MAX-role** (never downgrades): the owner or an
already-equal-or-higher member is a **no-op success** consuming **no use** and writing **no row**, and
concurrent claims can never exceed `maxUses`. A missing, expired, revoked, **maxed-out**, or
soft-deleted-project Invite all collapse to the **same** not-found, never forbidden, with no project
disclosure (ADR-0002's non-disclosure posture). Revoking the link blocks future redemptions but does
**not** strip an already-granted membership (member removal is its own operation). _(See ADR-0040
"Redemption protocol", ADR-0020.)_

### API token (`ApiToken`)

A bearer secret a signed-in user mints so an **agent** (an AI client speaking the MCP path) can
call the system _as that user_ — the system's **second bearer secret** alongside the
**capability-URL slug** (the slug grants link _read_ to one **Project**; this grants the user's
access over the MCP path). Minted from the **Connect-an-agent page**, **shown exactly once**, and
stored only as a **token hash** plus a non-secret **token prefix** for display — the raw token
never persists and is never logged (the slug's secret-in-logs posture, ADR-0002). Carries **token
scopes** and an **expiry**, and is **revocable** (soft — `revokedAt`, keeping the prefix/audit
trail). Owned by a `userId`; mint/list/revoke authorize through **access** on `userId` only, and a
token belonging to another user is reported not-found (no existence disclosure). The word is "API
token" user-facing and `ApiToken` in code — never "API key", "agent token"/"agent key" (the agent
_consumes_ it, it is not the agent's identity), or "PAT". The service verbs are
`createApiToken` / `listApiTokens` / `revokeApiToken` ("mint" is prose only); the UI button says
"Generate token". When a token resolves to an identity (#18, the MCP path) it produces an **Actor**
with `via: "token"`; authorization still derives only from `userId`. _(Minting, hash-at-rest,
prefix, and revocation are realized now; token→Actor resolution is **realized now** (#18, the MCP
read path) via `resolveActorFromToken`; scope enforcement remains a later milestone. See ADR-0020,
ADR-0021, ADR-0022.)_

### Token hash

How an **API token** persists: the raw token is run through a **keyed HMAC** (SHA-256) with a
server-side **token pepper** and only the resulting digest is stored (`tokenHash @unique`), so the
database never holds a replayable credential. #18 verifies a presented token by re-deriving the
same HMAC and matching the stored digest — the raw value exists only in transit and in the one-time
reveal. HMAC, not bcrypt/argon2: the token is 256-bit CSPRNG entropy, so slow password hashing buys
nothing and a deterministic keyed digest is exactly what lookup-by-hash needs. Never "encrypted
token" (a one-way digest, not reversible ciphertext) or "salted hash" (the secret is a server-wide
**pepper**, not a per-row salt — a salt would break lookup). _(See ADR-0020.)_

### Token pepper

The single server-side secret keying every **token hash** — `API_TOKEN_PEPPER`, added to the
schema-validated env (`src/env.js` server schema **and** `runtimeEnv`) but read directly from
`process.env` in `token-hash.ts` so a service test needn't load unrelated auth secrets (the
test-DB seam, ADR-0003). It is a **pepper**, not a **salt**: one application-wide _secret_ whose
compromise (with a DB dump) is what an attacker would need to brute-force tokens offline, so it
lives only in the environment. A `keyVersion` stamped per token selects which pepper keyed it, so
the pepper can be rotated without a hash migration; rotating it otherwise invalidates all tokens of
that version by design. Treated as a top-tier secret in logs, like the slug. _(See ADR-0020.)_

### Token scopes

The capability labels an **API token** carries (today only `read`), stored on the `ApiToken` and
later copied onto the **Actor** it resolves to. **Scopes are stored, not enforced**: per **Actor**
and ADR-0001, authorization derives only from `userId`; `scopes`/`via` never decide an authz
outcome. They exist now so the wire/DB shape is stable before any scope-gated capability lands, at
which point enforcement is an additive `access`-module change. The word is **scopes** in prose, UI,
and code — never "permissions" (over-claims enforcement that does not exist) or "roles" (that names
**Role**, the per-Project membership grade — a different, _enforced_ axis, ADR-0040). Scopes are
stored on the token and not enforced; a Role rank is resolved from `userId` and _is_ enforced.
_(See ADR-0021, ADR-0040.)_

### Connect-an-agent page

The signed-in, owner-only surface (`/connect`) where a user mints, lists, and revokes **API
tokens** for connecting an **agent**. User-facing title is **"Connect an agent"**; the artifacts it
manages are **API tokens**. It is the _producer_ side of the token; the _consumer_ side (resolving
a token to an **Actor** over MCP) is **realized now** (#18, see ADR-0022). Not a "settings", "API
keys", or "developers" page — it is framed around the user's goal (connect an agent), per the
convenience philosophy. It also renders copy-paste **MCP path** setup snippets for seven agent
clients (Claude Code, Codex CLI/IDE, OpenCode, OpenClaw, Hermes, Cursor) from the pure
`~/lib/mcp-clients` catalog, filling in the revealed **API token** when one is present (#94).

### Agent

An AI client that speaks the **MCP path**, authenticating with an **API token** that grants it the
minting user's access. The agent _consumes_ the token; the token is **not** the agent's identity (so
never "agent token" / "agent key" — see **API token**). It reads the architecture as deterministic
**markdown** **MCP resources** and maintains it via **MCP tools**. The word is **agent** — never
"bot", "client", "consumer", or "AI" as the domain noun. _(The authenticated read surface is
realized now via #18; the single-op MCP write tools — create / connect / update-docs / move — are
realized now via #19. The `apply_graph` batch tool is #20.)_

### MCP path

The authenticated route — `/api/mcp`, a Next.js route handler speaking **Streamable HTTP** — through
which an **agent** reads and maintains the architecture. A **thin adapter** (ADR-0001): it resolves
an **Actor** from a bearer **API token** (`resolveActorFromToken`, rejecting missing / revoked /
expired tokens with one indistinguishable 401 — **no anonymous access**) and calls the service
layer, holding no business logic or authorization of its own. The system's **second transport
adapter** after the tRPC API; unlike that API, the MCP path does not pass through the tRPC guard,
which is why authorization lives in the service layer (**access** module). The word is **MCP path**
/ **MCP endpoint** / **MCP server** — never "MCP API" (redundant; tRPC is "the API layer"), "the
agent endpoint" (the agent consumes it; the endpoint is not the agent's), or "MCP route". _(The
read surface is realized now via #18 (see ADR-0022); the **MCP write tools** — create / connect /
update-docs / move — are realized now via #19 (see ADR-0024). The `apply_graph` batch tool is #20.)_

### MCP resource

A read-addressable unit an **agent** dereferences over the **MCP path**, returning a **Project**'s
deterministic **markdown**. The three — **`index`**, **`project`**, **`subtree`** — are the
MCP-addressable face of **Markdown export**'s three modes, **not a new data vocabulary** (the same
map, addressed by URI). Addressed under the `architecture://` scheme by internal `projectId` (and a
`nodeId` for `subtree`) — **never by a user id**; an Actor reads the projects it owns **or is a
member of** (member parity #109; `guestAccess` is never consulted on the token path), and
`resources/list` enumerates exactly those via the member-aware `listProjectsForActor` (the
owner-only web `listProjects` is deliberately left untouched). The word is
**resource** — the MCP-spec native term, so no Component/Node split applies (the overload that
motivates the split is absent). Never "tool" (a **tool** invokes or mutates — see **MCP tool**),
"endpoint" (that names the route), or "query". A fourth read resource — **`trace`** (`architecture://trace/{traceId}`, #60) — reads one **saved Trace** as deterministic markdown of its cross-layer on-path subgraph; unlike the project-scoped three it is addressed by internal `traceId` and backed by a dedicated member-gated service (owner or member, ADR-0040 #109), but shares the same token gate, single-401, and non-disclosing not-found. _(Realized now via #18; the trace resource via #60. See ADR-0017, ADR-0022.)_

### MCP tool

A write-addressable unit an **agent** invokes over the **MCP path** to mutate the architecture. A
**thin adapter** (ADR-0001): each tool wraps a single service-layer call inside a `db.$transaction`
and surfaces the result as a short text confirmation that includes the affected row id, so the
agent can chain calls without an intermediate read. Authorization, invariants, and de-dupe live in
the service — the tool registers, parses, and translates errors only. The word is **tool** — the
MCP-spec native term, so no split applies. Never "action", "command", "mutation" (collides with
tRPC), or "verb". Today's surface is the **MCP write tools** — the four single-op tools (`create_component`, `connect_components`, `update_component_docs`, `move_component` — #19), the **`apply_graph`** batch tool (#20) for constructing many Components and Connections in one transaction (chained by **client id**, the in-batch reference handle the agent picks), and the **`apply_spec`** tool (#67) that wraps the **Spec** → **Component** generator (ADR-0029) on the agent surface — same `applySpecInput` the web `applySpec` uses, including the per-row `changed[]` / `dropped[]` resolution arrays (defaults are safe — skip / keep), re-parsing server-side, applying inside one transaction, and returning the counts the web surface returns. The surface also carries a **reversible destructive arm** (#19): `delete_component` cascades a soft-delete across a Component's subtree + incident Connections + owned Specs and returns the **Deletion id** undo handle that `restore_component` consumes, while `delete_connection` is a lone Connection soft-delete that mints **no** handle and so is not restorable over MCP (the asymmetry is the documented model — a lone `deleteEdge` mints no `deletionId`; ADR-0030). Honest copy never implies the lone delete is recoverable over MCP (ADR-0021). The catalog is plain data (`WRITE_TOOLS` in `~/server/mcp/tool-catalog.ts`), so the registration loop, `tools/list`, and `/llms.txt` all render from one source — additional tools plug in without touching the adapter, the auth gate, or the route. `connect_components` and the `apply_graph` `connections` arm carry an `interaction` input and accept cross-scope endpoints (#62; the `canvasNode` ref is dropped — see **Client id**). _(Realized now via #19 + #20 + #67; see ADR-0001, ADR-0008, ADR-0010, ADR-0022, ADR-0026, ADR-0027, ADR-0028, ADR-0029, ADR-0030, ADR-0038.)_

### llms.txt

The served discovery document at `/llms.txt` that tells an **agent** how to reach the **MCP path**,
authenticate (a bearer **API token** from the **Connect-an-agent page**), and address the **MCP
resources**. **Generated**, not hand-authored — its resource catalog renders from the same source the
**MCP server** registers from, so the doc and the live `resources/list` cannot drift. Honest about
the grant (ADR-0021): it describes capability ("a token acts on behalf of the minting user"), never a
"read-only scope" the token does not carry. The write surface now includes a reversible destructive
arm (`delete_component` / `restore_component` / `delete_connection`), and the doc is honest about the
one asymmetry — the lone Connection delete has no MCP undo (ADR-0038). Carries the
**prompt-injection standing note** that graph content is **data, not
instructions**. Never "manifest", "sitemap", or "robots.txt for AI". _(Realized now via #18; #67
extended the tool catalog with `apply_spec`, #19 with the delete/restore arm — both additive, no
doc-generation change required (the catalog renders dynamically). See ADR-0022, ADR-0038.)_

### Agent skill

The installable, hand-authored teaching artifact at `skills/documenting-architecture-with-infinite-docs/` (Anthropic **SKILL.md** format) that teaches an **agent** to document a target system end-to-end over the **MCP path** cold — the mental model (**Component** / **Connection** / **Canvas** / **boundary proxy**), the read ladder (`index` → `project` → `subtree`), a six-step documenting workflow, the `apply_graph`-vs-surgical decision, **client id** chaining, and the reversible-delete model (`delete_component` cascades and is undone by `restore_component`; the lone `delete_connection` has no MCP undo — prefer reparenting over deleting). Distinct from **llms.txt**: that is the _generated reference_ (endpoint, auth, error wire spec) the **MCP server** renders from the live catalogs; the skill is the _hand-authored teaching_ layer that **points at** the served `/llms.txt` for those wire mechanics rather than restating them (so they have one source and cannot drift). The prose is review-verified; the one machine-checkable fact it embeds — the set of **MCP tool** / **MCP resource** NAMES, listed in a shared `manifest.json` — derives its validity from a drift-guard test (`src/server/mcp/__tests__/skill-manifest.test.ts`) asserting set equality (both directions) with `WRITE_TOOLS` / `READ_RESOURCES`, so adding or renaming a catalog entry fails the test until the skill teaches it. The word is **agent skill** (or just **skill**) — never "manifest" (that names only the embedded name list), "plugin", or "prompt". _(Realized now via #95; see ADR-0037, which builds on ADR-0022 and honours ADR-0017/0021/0026/0027/0029/0031.)_

### Client id

The agent-chosen string an **apply-graph batch** uses to chain references between rows it is about to create in one **MCP tool** call — `parent` on a new Component, or `source` / `target` on a new Connection (the `canvasNode` ref is dropped — Edges no longer store scope; #62 / ADR-0026 amendment) — without an intermediate round trip to learn the server-minted ids. Each Component in the batch carries a `clientId` the agent picks (any non-empty string ≤ 64 chars); the response returns an `idMap: { [clientId: string]: serverId }` the agent uses for subsequent calls. Per-batch scope: a `clientId` means nothing outside the one transaction that materializes the map, and **carries no authorization** — it is a lookup key, not a bearer credential (writes still authorize through the **API token**-resolved **Actor**, ADR-0002). Each field that accepts a Component endpoint or a Component parent accepts EITHER a `clientId` from the same batch (`{ref:"client", clientId:"..."}`) OR an existing server id (`{ref:"server", id:"..."}`); the discriminator is explicit so a typo surfaces as "no such clientId in this batch" instead of silently rebinding to an unrelated server row. The word is **client id** in prose and `clientId` in code — never "ref id" / "batch id" / "local id" / "temp id". Clientids must be unique batch-wide so the flat `idMap` shape stays collision-free across any future additive arm. _(Realized now via #20 / `apply_graph`. The id-map type is `Record<string, string>` in code; the outer service result is `ApplyGraphOutput`. See ADR-0026.)_

### Deletion id

The handle that ties together one cascading soft-delete so it can be undone as a unit.
A single `deleteNode` mints one id and stamps it (`deletionId`) on every row it transitions to
deleted — the target **Node**, its subtree (including any spec-derived child Components, which
ride the ordinary subtree cascade), every incident or interior **Edge**, and the owned **Spec** —
and `restoreNode` clears `deletedAt` for _exactly_ the rows bearing that id, so an undo restores
the operation's set and nothing outside it. A `deleteEdge` is a **plain lone soft-delete**: it
sets `deletedAt` on the one Edge with **no** `deletionId` (there is no longer a FlowRoute cascade
to group). `restoreEdge`'s batch role narrows to the cascade restore driven by `restoreNode`.
A row removed by some other operation never carries this id and is never revived by undoing a
later one — a lone `deleteEdge` sets `deletedAt` with no `deletionId`, and an earlier delete
carries its own id. It is a _grouping of soft-deleted rows_, not a stored history: do not call it
a "transaction" (the database mechanism that writes it), a "version" or "snapshot" (nothing is
copied — rows are flagged in place), or an "audit log". Named in **Node**/**Edge**/**Spec** terms
in code; users see only "delete" and "undo".
_(Realized now via `deleteNode`/`restoreNode` and `deleteEdge`/`restoreEdge` for cascaded
edges, and exposed over the **MCP path** as `delete_component` / `restore_component` (the undo
handle is the `deletionId` the delete returns) — the lone `delete_connection` mints none, so it
has no MCP undo (#19, ADR-0038). See ADR-0008, ADR-0030 (cascade/undo without FlowRoutes,
superseding ADR-0014), and ADR-0011. The id is a bare stamped column today — a durable `Deletion`
entity is deferred, additive future work.)_

### Soft-delete + undo

Deletes set a `deletedAt` timestamp rather than removing rows; reads filter out soft-deleted
records; the operation is reversible. This matters specifically because AI agents mutate the
graph, and a recoverable delete is the safety net for an automated change gone wrong. _(Realized
now for a Component: `deleteNode` cascades a soft-delete across the Node, its subtree, every
incident or interior **Edge**, and the owned **Spec** as one
**Deletion id**, and `restoreNode` reverses exactly that set (ADR-0008 + ADR-0030). Both are
**writes** — owner-only, never slug-granted (ADR-0002). The `Project` model also carries
`deletedAt` and all reads filter it; Project-level cascade remains future.)_

### Flow

Retired with the Flow capability model (#62 / ADR-0030). A **Connection** is now a directed,
typed edge carrying its own **Interaction**; the named data-movement units a Component exposed
are no longer modeled. The 1:1 import row formerly `FlowSpec` became **Spec** (see entry).
Historical: ADR-0011.

### Spec (`Spec`)

The imported contract — an OpenAPI/AsyncAPI/GraphQL/SQL-DDL/TypeScript document or hand-authored
`CUSTOM` prose — that **materializes a tree of derived child Components** on its owner Component
(#64 / ADR-0029). 1:1 with a Component (`ownerNodeId @unique`, enforced live-only by
`idx_spec_owner_live`); renamed from the retired `FlowSpec`. Where the old FlowSpec projected
**Flows**, a Spec now points at derived child **Components** via their `Node.sourceSpecId` +
`Node.specKey` provenance columns. A pasted **OpenAPI** doc on an API Component creates
**Endpoint** children (params as nested generic children, request bodies summarized into
`metadata`); pasted **SQL-DDL** on a Database creates **Table** children (columns as nested generic
children with type/nullability/PK in `metadata`). SQL-DDL **foreign keys** additionally
materialize as **Connections** between the Table Components — a directional `REQUEST` Edge per
ordered table pair, carrying **Edge** spec provenance (#76 / ADR-0033; see **Edge**). Re-paste is a
**user-resolved merge** for Components: nothing writes until the user confirms the conflict-modal
decisions (skip / overwrite [keep|wipe docs] for changed rows; keep [detach] / delete for dropped
rows). FK **Connections**, by contrast, are **auto-reconciled** (they hold no user content — created,
dropped, and refreshed without per-Connection prompts; the modal shows only counts). Position and
incident Connections are **always preserved**; matched Components keep their Node id, so Connections
drawn to a generated Component survive re-parse. The default for an unresolved row is the **safe** action (skip /
keep). `source` is **UNTRUSTED user-pasted content** — stored verbatim, parsed only by a
bounded loader (size + node-count + depth caps; bound breach surfaces one `parseError` and
generates nothing — never partial). No user/code split (it rides the exception — "Spec" / `Spec`).
_(#62 landed the renamed row, the provenance columns, and the cascade (`deleteNode` sweeps the
owned Spec — ADR-0030). #64 lands the spec→Component **generation** itself — the parser registry
(OpenAPI + SQL-DDL today, others reserved), the recursive `ParsedComponent` tree, the pure
`parseSpecDiff`, and the `previewSpec`/`applySpec` services driving the conflict modal. Its source
format is a **spec kind** (`SpecKind`). Historical: ADR-0011 (superseded by ADR-0029), ADR-0025
(amended by ADR-0029).)_

### Component provenance

A Component is either **user-placed** (the canvas Add gesture) or **generated** (materialized by a
parsed **Spec**; #64 / ADR-0029). Generated provenance is recorded by two columns on the **Node**:
`sourceSpecId` (the **Spec** it was derived from) and `specKey` (the parser's stable per-format
identity for it — `operationId` else `METHOD path` for OpenAPI, table name for SQL-DDL, qualified
by the parent's key for nested rows). **"Generated" is a provenance modifier, never a Component
type.** A generated Endpoint is an ordinary `kind: ENDPOINT` Node; a generated Table is an ordinary
`kind: TABLE` Node; `GENERIC` appears only when the parser cannot infer a kind (parameters,
columns — until they earn dedicated kinds). Generated Components nest, connect, descend, and are
documented exactly like user-placed ones. Re-parse uses `specKey` to match Components across runs,
which is what lets it preserve Node id / position / incident Connections without asking the user.
The merge UI's "keep (detach)" action clears both columns — the Component becomes user-owned with
its docs and Connections retained, leaving the Spec.

### Interaction (`Interaction`)

A **Connection**'s type, stored on its **Edge** as `interaction: Interaction` (default
`ASSOCIATION`). Five values: a default undirected `ASSOCIATION` plus four **directional**
interactions that describe, from the perspective of the **`source`** endpoint, how it
participates — the verb from which the Connection's arrowheads are _derived_ together with draw
order (#65; not a stored arrow):

- `ASSOCIATION` — a plain undirected relationship; **no arrowheads** (the default a freshly drawn
  Connection carries). De-dupes as an unordered pair.
- `REQUEST` — `source` is _called_ in request/response (REST, RPC, a served GraphQL field); the
  dependent end points **at** `target`.
- `PUSH` — `source` _emits_ unprompted (SSE, a webhook it sends, an event it publishes); the arrow
  points **away** from `source` (at `target`).
- `SUBSCRIBE` — `source` _consumes_ an external stream/feed; the arrow points **at** `source`.
- `DUPLEX` — `source` both sends and receives (a WebSocket); arrows at **both** ends.

It answers "what kind of relationship is this, and (for the four directional values) which way
does data move relative to `source`?". `interaction` is in the directional de-dupe key — `A→B
REQUEST` and `A→B PUSH` are distinct Connections — but `ASSOCIATION` de-dupes on the unordered
pair (one Association per Component pair). The canonical `(interaction, source, target) → markers`
mapping lives in one helper (the successor to `~/lib/flow-direction`): `REQUEST`/`PUSH` → arrow at
`target`; `SUBSCRIBE` → arrow at `source`; `DUPLEX` → both; `ASSOCIATION` → neither. The word in
prose and UI is **interaction**; the type name in code is `Interaction` (no user/code split — see
the exception block) — the same prose/type-name pattern **Component kind** / `NodeKind` uses,
minus the prefix. Never "direction" (the arrow is derived from `(interaction, source, target)`,
not a stored field — re-introducing a stored `direction`/`polarity`-on-edge regresses ADR-0027)
and never "edge type" / "kind" (there is no `EdgeKind`; `interaction` is the only typing axis).
`REQUEST`/`PUSH`/`SUBSCRIBE`/`DUPLEX` are the four directional successors carried over from the
retired Flow model (where they were owner-relative); `ASSOCIATION` is the new default for an
untyped plain-line Connection. *(Realized now as a per-Connection field set at `connectNodes`
(default `ASSOCIATION`) and editable after creation via the picker on the selected Connection
(`updateEdgeInteraction`). Arrowhead rendering from `interaction` is realized now (#65), derived by
the canonical `~/lib/connection-direction` helper shared with the exporter (ADR-0027). User-facing
labels live in `INTERACTION_LABEL` (`~/lib/interactions.ts`), keyed by `Interaction` so a new value
fails to compile until labelled — the same exhaustiveness guard `KIND_LABEL` gives Component
kinds. Each directional interaction also carries a resting-Canvas **glyph** in `INTERACTION_GLYPH`
(`~/lib/interactions.ts`, `Record<Interaction, LucideIcon | null>`), so a directional Connection
reads at a glance before selection; `ASSOCIATION` maps to `null` by design — a plain relationship
stays bare. Keyed by `Interaction` so a new value fails to compile until it gets a glyph, the same
guard the labels above carry and the `KIND_ICON` precedent in `~/lib/node-kinds.ts`. The glyph is a
*kind* cue, never a direction signal — the arrow stays derived from `(interaction, source, target)`
(ADR-0027, ADR-0039).)*

### Component-detail panel

The slide-in surface that opens when a **Component** is selected on the **Canvas** — a sidebar,
not a modal, so panning and zooming continue behind it (performance). It hosts the Component's
**kind** row, the **Connections section** (#66), and the markdown **documentation** editor
(ADR-0015). **Dual-audience:** the owner
sees the full edit surface; a **viewer** (a non-owner holding the capability slug) sees the _same
panel read-only_ — rendered documentation (Plate `readOnly`), with no kind picker and no docs Edit
toggle. The read-only affordances are _omitted, not disabled_, so the viewer panel never signals
an edit it cannot perform; read-only mode is presentation only — writes remain owner-only at the
service layer (ADR-0002). The word is **Component-detail panel** — never "inspector", "sidebar"
(names the layout, not the surface), or "properties panel". _(Realized now; the read-only viewer
variant landed with issue #16. The **Spec** paste field and the **Flow palette** it formerly
hosted were removed with the Flow model (#62); the spec → Component generation surface returns in
#64. The **Connections section** landed with #66. See ADR-0002, ADR-0015.)_

### Connections section

The **Component-detail panel** section that lists a Component's **Connections** and lets the owner
add one (#66 / ADR-0032). **Dual-audience:** every reader (owner or **viewer**) sees the list —
each row resolves the _far_ endpoint to its title and **kind** and shows the **Interaction**
relative to this Component; only the owner sees the **"Connect to…"** add affordance (omitted, not
disabled, for a viewer — ADR-0002). The list is **complete across scopes**: it is node-keyed
(`listNodeConnections`), so it includes a Component's **lineal** Connections to its own descendants
— which _collapse_ off its home **Canvas** and so never appear in **getCanvas** — not just the ones
visible on the current Canvas. The **"Connect to…"** search behind the add control is a project-wide
Component picker (`listProjectComponents`) built on the same `cmdk` **Command** primitive the **kind
palette** uses; it searches every Component at any depth by title or kind. Adding a cross-scope
Connection inserts the far-end **boundary proxy** optimistically and reconciles on success (ADR-0031,
ADR-0032). The word is **Connections section** — never "links panel" or "edges list" (the user word
is **Connection**). _(Realized now via #66.)_

### Flow palette

Retired with the Flow model (#62). The read-only list of a Component's **Flows** is gone with the
Flows it listed; the **Component-detail panel** keeps only the **kind** row and the documentation
editor. (The _palette_ prose/UI convention — the word names the surface, not the library — lives
on in the **Kind palette**.)

### FlowRoute

Retired with the Flow model (#62 / ADR-0030). Connections no longer carry routed Flows; a
Connection's **Interaction** is intrinsic, not derived from routes. The cross-scope inner-Edge
writer (`routeFlow`) is deleted. Historical: ADR-0011, ADR-0012, ADR-0023.

### Flow kind (`FlowKind`)

Retired with the Flow model (#62). It was the cosmetic categorization of Flows; no successor — a
Connection's only typing axis is **Interaction**, and there is no `EdgeKind`.

### Spec kind (`SpecKind`)

A **Spec**'s source format, stored on it as `kind: SpecKind`. One of six values: `OPENAPI`,
`ASYNCAPI`, `TS_SIGNATURE`, `GRAPHQL`, `SQL_DDL`, `CUSTOM`. Renamed from `FlowSpecKind` with the
Flow model's retirement (#62). The value selects which parser materializes derived child
**Components** from `source` (#64); `CUSTOM` is hand-authored prose the canonical parsers do not
cover. The word in prose and the enum name in code are **spec kind** / `SpecKind`. _(The enum +
column land in #62; the parser registry and the per-Component affinity that ranks which spec kinds
a Component is offered — presentation-only, ADR-0019 precedent — are (re)built with the
spec→Component generator in #64. See ADR-0011, ADR-0025.)_

### Markdown export

The byte-stable serialization of a **Project** — or one of its subtrees — to markdown for human
"Copy as markdown" use and the **MCP resources** (realized now via #18). Slug-readable on the web
path (ADR-0002, the same posture **getCanvas** uses) and member-gated on the MCP path (owner or
member, `view` on the capability ladder; ADR-0022 / ADR-0040 #109), with three modes:

- **Full project** (`canvasNodeId: null`, `mode: "full"`) — every **Component** in the Project,
  authored documentation included (heading-shifted), plus a **Connections** section.
- **Subtree** (`canvasNodeId: R`, `mode: "full"`) — R + descendants only, with a **Boundary
  context** section listing one row per boundary-crossing **Connection** (far endpoint named with
  its `{#nodeId}` anchor and **kind**) so a deep slice is readable without re-walking up to the
  root.
- **Index** (`mode: "index"`) — a cheap structural map: titles, **Component kind**s, anchors,
  per-Component **Connection** counts; doc bodies omitted. The navigable view an indexing
  agent reads first.

Each Component carries an addressable HTML-style anchor `{#nodeId}`. Each **Connection** serializes
**exactly once** at its real `(source, target)` endpoints, NEVER mirrored under altitude reprs
from **getCanvas**'s presentation projection (otherwise an LLM counting Connections from the
markdown would over-count dependencies). The line shape is
`- Source {#sourceId} <glyph> Target {#targetId} · label`, where `<glyph>` is derived from
`arrowEnds(interaction)` (the canonical helper in `~/lib/connection-direction`, ADR-0027) — `→` for
`REQUEST`/`PUSH`, `←` for `SUBSCRIBE`, `↔` for `DUPLEX`, `—` (em-dash) for `ASSOCIATION`; the label
separator is `·` (mid-dot, the punctuation already used in the export header) so it never
collides with the ASSOCIATION glyph. Sort key is `(sourceId, targetId, interaction, edgeId)`,
codepoint-ascending. Authored documentation is **heading-shifted via an mdast AST walk**
(`unist-util-visit` over `remark-parse`), never via regex — a fenced code block containing a literal
`#` line round-trips intact. Output is **deterministic across runs AND OS locales**: ordering is
computed in application code with a Unicode codepoint comparator (`<`/`>`), never delegated to SQL
collation or `String#localeCompare` / `Intl` (those are banned in the serializer module).
`remark-stringify` options are pinned explicitly so a library version bump cannot silently
re-baseline the byte output. Locked by a golden-file byte-equality test that also mutates `LANG` /
`LC_ALL` to prove locale invariance. **Generated Components** (#64 / ADR-0029) serialize as ordinary
nested Components — `kind` is cosmetic, provenance never appears in the output — and their `{#nodeId}`
anchors stay stable across re-parse because `parseSpecDiff` preserves `Node.id` on matched `specKey`
rows. _(Realized now via two owner-resolving front doors over one shared fetch core
(`serializeProjectScope`) in `src/server/architecture/export.service.ts` — `exportMarkdown(db,
actor, input)` (slug-readable, web) and `exportMarkdownForActor(db, actor, input)` (member-gated by
`projectId` via the capability ladder, the MCP read path #18 / ADR-0022 / #109) — both depth-independent, honouring the
single-round-trip posture (ADR-0001), and both delegating to the pure `serializeGraph` in
`src/server/architecture/markdown.ts`. The typed cross-scope rewrite landed at #67 (which amends
ADR-0017): each Connection serializes exactly once with its `interaction` glyph, deterministically
ordered; the subtree Boundary section lists one row per crossing Connection (no `direct/inherited`
partition — ADR-0031 per-edge posture extended to the export consumer); generated Components
serialize as ordinary Nodes with stable anchors; the goldens were re-baselined once, locale-
invariance and heading-shift tests stayed green. The "Copy as markdown" toolbar action and the
breadcrumb-bar scope-anchored copy ship the client-side surface. See ADR-0017.)_

### Trace

A user-marked path query across the architecture graph: pick two or more **Components** as **trace points**, and Trace shows every Component and **Connection** lying on a path between them, expanded across all layers at once. Trace answers "how do these parts of the system reach each other?" without manually descending each **Canvas**. It is a **derived view over a point set** — the marks persist, the on-path subgraph is recomputed on read by `getTraceView` over the unified undirected (Connection ∪ nesting) graph (ADR-0034). The working selection is the **working trace**; viewing it is the **Trace view**. The word is **Trace** (capitalized as a feature noun) — never "path", "route" (collides with the Project route / the retired FlowRoute), or "trail" (collides with the breadcrumb trail). _(Marking **trace points** into a client-side **working trace** with canvas feedback and the working-set manager, the cross-layer derivation/nested render, AND named/**saved Traces** (#59 — save/list/load/share via the saved route) are realized now; the MCP trace resource + serializer trace mode (#60) are realized now too — a saved Trace reads as deterministic markdown at `architecture://trace/{traceId}`, member-gated (owner or member, #109).)_

### Trace point

A **Component** the user has marked for inclusion in a **Trace**. A trace point is a _mark on a Component_, not a Component **kind** and not a stored attribute — it carries no behavior and grants no permission (kind stays cosmetic, ADR-0018/0019; a trace point is orthogonal to kind). Marking is available to **owner and viewer** alike because it is client-side selection state, not a write (ADR-0002 — the capability slug grants read; marking mutates nothing server-side). Two or more trace points define a Trace. The word is **trace point** — never "marker", "pin", "anchor", or "endpoint" (which names a Connection's end and the `ENDPOINT` kind). _(Marking a Component as a trace point — via the **Trace this Component** checkbox in the **Component-detail panel**, shown to every reader — and its canvas indicator are realized now.)_

### Working trace

The **unsaved, client-side set of trace points** a user is currently assembling — the in-progress selection before any named **Trace** is saved. It is a **per-browser working set persisted to `localStorage`, keyed by Project**, so it survives reload but is local to one browser and never written to the server in this form. Saving a working trace as a named, shared **Saved Trace** is realized now (#59); loading a saved Trace REPLACES the working trace with its points (with an undo toast if unsaved points are discarded). Reaching two or more trace points is what unlocks the **Trace view**'s graph. The word is **working trace** — never "draft trace", "selection", or "pending trace"; it is the _working_ set, distinct from a **saved Trace**. _(Realized now as a `localStorage`-backed, per-Project client store feeding the **Component-detail panel** checkbox, the canvas trace-point indicator, and the **Trace view** working-set manager + save/load.)_

### Trace view

The route that opens a **Trace** — reached from the always-enabled header **Trace** button, riding the Project **capability slug** so any slug-holder (owner or **viewer**) can open it (ADR-0002). With two or more **trace points** it renders the cross-layer **Trace subgraph** — the derived union, over every pair of **trace points**, of every **Component** and **Connection** on some path between that pair (plus each Component's nesting ancestors), computed read-only by `getTraceView` and capped at 500 Components — as a dagre-auto-laid-out nested-box React Flow island, every involved layer visible at once and **read-only for everyone** (even the owner): no drag, no connect, no edit; clicking a Component opens its read-only detail with a "Go to canvas" jump to its real layer (ADR-0034). Below the threshold it renders the **working-set manager** — the current **working trace** listed with per-point remove and a clear-all, plus the "add 2+ points to see the graph" empty state. The word is **Trace view** — never "trace page", "trace panel", or "trace canvas" (it is not an editable **Canvas**). It also hosts the **Saved Traces** panel (#59): the owner can save the working trace as a named Trace and rename/delete saved ones; every reader can list and load them. _(Realized now at `/p/[slug]/trace`: the working-set manager / empty state, the cross-layer derivation + nested render, AND the Saved Traces panel + the saved route `/p/[slug]/trace/[traceId]` (#59); the MCP/serializer trace projection (#60) is realized now — the member-gated `architecture://trace/{traceId}` resource serializing a saved Trace's on-path subgraph (owner or member, #109).)_

### Saved Trace

A named, persisted **Trace** — a stored set of **trace points** over a Project, owned by the Project and addressed at `/p/[slug]/trace/[traceId]`. Distinct from the **working trace** (the unsaved, per-browser `localStorage` set): a saved Trace lives in the database (`Trace` + `TracePoint` rows), is shareable by the project **capability slug** (any slug-holder reads; only the owner saves/renames/deletes — ADR-0002), and is soft-deletable + undoable as one `deletionId` batch (ADR-0030). Only the POINT SET persists; the on-path subgraph is recomputed on read by `getTraceView` (derived, like **Canvas**; ADR-0034). Loading a saved Trace REPLACES the working trace with its points (with an undo toast if unsaved points are discarded). The word is **saved Trace** (or **named Trace**) — distinct from **working trace**; never "trace template" or "stored path". _(Realized now via #59; ADR-0035. The MCP trace resource that reads a saved Trace — member-gated `architecture://trace/{traceId}` (owner or member, #109), deterministic markdown — is realized now via #60.)_

## Standing notes

### Prompt-injection standing note

Component documentation, titles, and any other user-authored content are **untrusted input**.
When this content is later fed to an LLM (markdown export, MCP resources), it must be treated as
**data, never instructions**. A Component's docs can say "ignore previous instructions" — and
the system must not. Every code path that hands graph content to a model carries this obligation.
Defenses live at the output/serialization boundary (added in a later milestone); today we only
adopt the mindset — store text verbatim and never interpolate user content into queries.

**Parse-time trust too.** Untrusted content that is later _parsed_ — a pasted **Spec**'s
`source`, future contract imports — must go through a **bounded loader** with size and depth
caps so a hostile input cannot OOM the server before it ever reaches the output boundary. The
caps belong to the parser itself (testable in isolation), not just the API surface; a future
caller bypassing input validation must still hit the cap.
