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

Rule of thumb: anything a human reads or an MCP agent calls says **Component** / **Connection**;
anything in the Prisma schema, service signatures, or graph algorithms says **Node** / **Edge**.

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
now), batch position writes (`updatePositions`), and **Connection**/**Edge**
wiring (see **Edge**) are realized now; broader Component editing (`kind`,
`documentation`), reparenting (`move`) with cycle prevention, and cascading
**soft-delete** land in later milestones.)*

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
The user-facing link between two Components, drawn on a **Canvas** by connecting one to
another. Carries an optional **label** (untrusted user content — stored verbatim, never
interpreted; see the prompt-injection standing note) and a **direction** (see **Edge
direction**). Backed by an **Edge**. *(Drawing, labeling, directing, and removing a Connection
are realized now — see **Edge** for the same-Canvas, no-self-link, and no-duplicate-active
rules; the refinement Connection that resolves a **boundary proxy** to a real Component (M5)
lands later.)*

### Edge
The data-model representation of a **Connection**: the stored graph edge with `sourceId` and
`targetId` (both **Nodes**), a `direction` (`EdgeDirection`, see **Edge direction**), an
optional `label`, and a soft-delete column (`deletedAt`). Scoped to the Canvas it is drawn on
by an **explicit `canvasNodeId`** (the Component whose interior Canvas owns the Edge; null = the
**Project** root), rather than being inferred from its endpoints — endpoints can later span
scope levels (the M5 refinement Connection), so scope is recorded, not derived (ADR-0005).
Three invariants hold and are enforced **in the service, not the database** (ADR-0005): both
endpoints sit on the **same Canvas** as the Edge, an Edge never links a Node to itself, and no
two *active* (non-soft-deleted) Edges share the same source, target, and scope. Never surfaced
to users by this name. *(The `Edge` model, `connectNodes`/`updateEdge`/`deleteEdge`, and the
**getCanvas** `interiorEdges` read are realized now; partial-unique-index hardening of the
de-dupe rule, and Connection undo, are later refinements.)*

### Edge direction (`EdgeDirection`)
A **Connection's** orientation, stored on its **Edge** as `direction: EdgeDirection`. One of
three values: `NONE` (undirected), `FORWARD` (source → target, the default), and
`BIDIRECTIONAL` (both ways). The word in prose is **direction** and the enum name in code is
`EdgeDirection` — never "arrow" or "directionality". **Direction is cosmetic:** it drives only
how the Connection is drawn (no arrowhead, one, or two) and never factors into de-duplication
(two Connections are duplicates by source + target + scope alone, regardless of direction; see
**Edge** and ADR-0005). User-facing labels are *Undirected, Directed, Bidirectional*. As with
`NodeKind`, this Zod enum is the client-safe source of truth (`~/lib/schemas`), the Prisma
`EdgeDirection` enum mirrors it, and a compile-time parity guard in the service layer fails the
build if the two ever drift. *(All three values are realized now; later directions, if any, are
an additive change.)*

### Canvas
A **derived view, not a stored entity.** The Canvas of a Component `N` is
`{ Nodes where parentId = N } ∪ { Edges where canvasNodeId = N }`. The Project root has its own
top-level Canvas (the Nodes with `parentId = null`). Because it is derived, a Canvas is never
written directly — you mutate Nodes and Edges, and the Canvas falls out. *(The Node half of
the derivation is realized now via **getCanvas**, and the Edge half is realized now too
(`{ Edges where canvasNodeId = N }`); reading a non-root scope is realized now via
**getCanvas**, while user-facing navigation into it arrives with **Descent**.)*

### getCanvas
The single service read that materializes a **Canvas** for a given **Canvas
scope** in one round trip. Its full result is
`{ interiorNodes, interiorEdges, boundaryProxies, breadcrumbs }`, derived without
a per-level query walk. Because a Canvas is a *derived view*, `getCanvas` returns
the **Nodes** and **Edges** that fall out of the scope — it is the read half of
the Component/Node split, so its result is named in **Node**/**Edge** terms in
code and tests even though the feature is described to users as "the interior
**Components**". *(Realized partially now — `getCanvas` returns `interiorNodes`,
`interiorEdges`, and `breadcrumbs` for a scope; `boundaryProxies` lands with
boundary derivation (M3). A non-null scope that resolves to no live Node in the
Project is a not-found. See ADR-0001 for the single-round-trip service contract,
ADR-0004 for how the payload reaches the client island, ADR-0005 for the explicit
`canvasNodeId` Edge scope, and ADR-0006 for the single recursive breadcrumb
query.)*

### Canvas scope
Which **Canvas** an operation is acting on. A Canvas has **no id of its own** (it
is derived, not stored), so a scope is identified by the **Component whose
interior Canvas it is**: the scope "is" a `Node`, and that Node's `id` is the
`parentId` of the Components on it. The **Project root** is the scope with no such
Component — represented as `parentId = null` in the data model and as the
sentinel string `"root"` at the canvas-island boundary (ADR-0004 keys the island
by scope so descending re-seeds the store). Use **scope** for this concept in
prose and code; do not invent a `canvasId` (there is nothing to give an id to)
and do not call it a "level", "context", or "view". *(The root scope and reading
at non-root scopes are realized now via **getCanvas**; user-facing navigation into
non-root scopes arrives with **Descent**.)*

### Breadcrumbs
The ordered ancestor chain of a **Canvas scope**: the **Components** from the
**Project** root down to, and including, the scope's own Component. Returned by
**getCanvas** as `breadcrumbs`, named in **Node** terms in code (like
`interiorNodes`) even though users see Components. Shape `{ id, title }[]`, ordered
**root → current** (root-most first, the current scope last). The **root scope**
has no Component, so its breadcrumbs are the empty array `[]` — no `"root"`
sentinel lives inside the chain (that string is a canvas-island key, not data;
ADR-0004). Computed in a **single recursive query**, never a per-level walk
(ADR-0006). *(Realized now in the data layer ahead of **Descent** navigation; the
Descent UI renders them later.)*

### Descent
The act of opening a Component to enter its interior **Canvas**, moving one level deeper into
the graph. Recurses to any depth. *(Defined now; navigation is implemented in a later
milestone.)*

### Boundary proxy
A read-only stand-in for an external system that a Component connects to on its *parent* Canvas,
projected inward so that dependency context is not lost on the way down. Boundary proxies are
**derived and inherited transitively** through the subtree — they are not independently editable
Components. *(Defined now; derivation and rendering are implemented in a later milestone (M3).)*

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
indistinguishable not-found. *(The empty top-level Canvas route lands in this milestone; routing
into interior Canvases via **Descent** is a later milestone.)*

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

### Soft-delete + undo
Deletes set a `deletedAt` timestamp rather than removing rows; reads filter out soft-deleted
records; the operation is reversible. This matters specifically because AI agents mutate the
graph, and a recoverable delete is the safety net for an automated change gone wrong. *(Defined
now — the `Project` model carries `deletedAt` and all reads already filter it — but cascading
deletes and undo are implemented in a later milestone (M1).)*

## Standing notes

### Prompt-injection standing note
Component documentation, titles, and any other user-authored content are **untrusted input**.
When this content is later fed to an LLM (markdown export, MCP resources), it must be treated as
**data, never instructions**. A Component's docs can say "ignore previous instructions" — and
the system must not. Every code path that hands graph content to a model carries this obligation.
Defenses live at the output/serialization boundary (added in a later milestone); today we only
adopt the mindset — store text verbatim and never interpolate user content into queries.
