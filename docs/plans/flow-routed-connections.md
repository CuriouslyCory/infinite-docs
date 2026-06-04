# Master Plan — Flow-Routed Connections

> Synthesis of four parallel plans (two from the application architect, two
> from the senior engineer) for evolving the Connection model into one that
> captures multi-level data flow. Tracks the work in GitHub issue #2.
>
> Status: **Slices 1 + 2 + 3 shipped** (Slice 1: PR #41 / commit `b1c0627`,
> ADR-0011. Slice 2: same-Canvas baseline routing — `FlowRoute` schema,
> `routeFlow` / `unrouteFlow`, `deleteEdge` cascade with `restoreEdge`,
> `getCanvas.edgeFlows` aggregation, "+ flow" popover and "N / M routed"
> pill; the deleteEdge/restoreEdge cascade decision is ADR-0014, with a
> pointer from ADR-0008. Slice 3 (#36, absorbing #13 + #14): boundary
> derivation + boundary-proxy node + Flow palette + the gated cross-scope
> `routeFlow` inner-Edge writer + reference-counted shared-inner-Edge
> cascade + `getCanvas.boundaryProxies`/`flowPalettes` + `getFlowPalette`
> pagination — ADR-0012 documents the sole cross-scope Edge writer; MCP
> deferred to #42). Slices 4–5 remain plan-only. ADRs land per slice. The
> "Open questions" section at the bottom has been resolved for Slice 1 —
> entries are kept as a record of the decisions and where they were captured.
>
> **apply_graph substrate**: shipped via #20 (Components + Connections only; flows/routes arms remain Slice 5 / #38).

## The kernel insight

Today's `Edge` is a pipe with a label. The PRD's vision needs three things the
current model lacks:

1. **The pipe's contents are first-class** — an OpenAPI operation, a WebSocket
   channel, a function call: each is addressable, indexable, individually
   soft-deletable.
2. **Contents are owned by the _Component_, not the _Connection_** — an API
   "exposes" `GET /users` whether anyone is calling it or not. Drawing a
   Connection picks which exposed flows travel.
3. **Refinement is an explicit binding** between an outer Connection and inner
   Connections — never a derived heuristic that can rot.

Two new entities (`Flow`, `FlowRoute`) plus a new `FlowSpec` source-of-truth.
Zero changes to today's `Edge` shape. Direction stays structural (ADR-0009).
Same-Canvas stays the rule (ADR-0005) with one explicit exception isolated in
one named service function. Edge de-dupe is now backstopped by a partial unique
index per ADR-0010's named pattern (`idx_edge_dedup`), and every new
soft-deletable de-dupe rule below MUST adopt that pattern.

## Vocabulary additions (will land in CONTEXT.md per slice)

- **Flow** (user) / **Flow** (code): a named, directional unit of data movement
  a Component exposes — an OpenAPI operation, a WS channel, an SSE stream, a
  function call. Owned by a Component (`ownerNodeId`). Exists on its owner
  whether or not anyone calls it.
- **Flow spec** / **FlowSpec**: the imported contract (OpenAPI, AsyncAPI, TS
  signature, GraphQL) that materializes a set of Flows on its owner Component.
  Spec is the source of truth; Flow rows are its parsed projection, regenerated
  by re-parse.
- **Route** / **FlowRoute**: the binding that says "this Connection at this
  scope carries this Flow, and one level deeper, that Flow continues as that
  interior Connection." Names exactly one outer Edge and zero-or-one inner
  Edge.
- **Flow palette**: the read-only UX surface exposing a Component's Flows.
  Visible on the Component when you select it; visible on a boundary proxy
  after Descent.
- **Polarity**: a Flow's directional relationship to its owner — `INBOUND`
  (owner consumes; e.g. `GET /pets`) or `OUTBOUND` (owner emits; SSE, event).
  The owner-relative answer that makes bidirectional pipes resolve to two
  Edges without storing a `direction` field anywhere.

## Data model

```prisma
enum FlowKind     { GENERIC OPENAPI_OPERATION ASYNCAPI_CHANNEL SSE_STREAM WEBSOCKET FUNCTION_CALL EVENT }
enum FlowSpecKind { OPENAPI ASYNCAPI TS_SIGNATURE GRAPHQL CUSTOM }
enum FlowPolarity { INBOUND OUTBOUND }

// 1:1 with a Component. The contract; Flow rows are its parsed projection.
model FlowSpec {
  id          String       @id @default(cuid())
  projectId   String
  ownerNodeId String       @unique
  kind        FlowSpecKind
  source      String       // raw text; untrusted (prompt-injection standing note)
  parsedAt    DateTime?
  parseError  String?      // when present, derived Flows are stale-or-absent
  // ... timestamps, deletedAt, deletionId
}

// A named capability exposed by a Component.
model Flow {
  id           String       @id @default(cuid())
  projectId    String
  ownerNodeId  String       // the Component that exposes this capability
  sourceSpecId String?      // null = user-authored; non-null = derived
  kind         FlowKind     @default(GENERIC)
  key          String       // stable: "GET /pets", "channel:tickUpdates"
  title        String       // untrusted display label
  polarity     FlowPolarity
  signature    Json?        // OAS op JSON / AsyncAPI message / fn sig
  // ... timestamps, deletedAt, deletionId
  // de-dupe: (ownerNodeId, key) among active rows; service-primary with a
  //   partial-unique-backstop per the ADR-0010 pattern (ADR-0005 + ADR-0010)
}

// Binds a Flow to an outer Edge at one scope and (optionally) an inner Edge
// at the next scope down.
model FlowRoute {
  id          String   @id @default(cuid())
  projectId   String
  flowId      String
  outerEdgeId String                                       // the pipe at this scope
  innerEdgeId String?                                      // the refinement, one scope deeper
  // ... timestamps, deletedAt, deletionId
  // de-dupe: (outerEdgeId, flowId) among active rows; same ADR-0010 pattern as
  //   Flow above — partial unique index `idx_flow_route_dedup` WHERE deletedAt
  //   IS NULL, a narrowed `isFlowRouteDedupCollision` in `prisma-errors.ts`, and
  //   `ConflictError.details.conflictingFlowRouteIds` (additive extension of
  //   `ConflictErrorDetails`).
}

// Edge unchanged in shape; only relation arms widen.
```

`Edge.label` stays — it names the _pipe_ (e.g. "primary HTTPS"). Flow titles
name the per-call content. They're complementary.

## Direction stays structural (ADR-0009 verbatim)

Every Edge keeps its single output→input arrow. A Flow's rendered direction at
the parent level is structural too — derived from its polarity vs which
endpoint is its owner:

- `polarity = INBOUND` ⇒ Flow rides an Edge whose **target** is the owner.
  Arrow already points at owner.
- `polarity = OUTBOUND` ⇒ Flow rides an Edge whose **source** is the owner.
  Arrow points away from owner.

**Bidirectional traffic = two Edges, not two arrowheads on one Edge.** When a
user adds an OUTBOUND Flow on the API and only a Web Server → API Connection
exists, the canvas offers one-click "Add API → Web Server Connection to carry
this?" The data model never knows what "bidirectional" means; it always knows
what _flows go what way_.

## The OpenAPI worked example, end-to-end

**Scene 1 — Paste the spec.** User opens API Component's detail panel, pastes
OpenAPI YAML. Single mutation
`attachFlowSpec({ownerNodeId: apiId, kind: OPENAPI, source})`. Server parses
with a bounded loader (size + depth caps so a hostile spec can't OOM), upserts
one Flow per operation with `polarity = INBOUND`. The API Component now shows
a "14 flows" pill. _Re-pasting later: matching keys preserved, dropped keys
soft-deleted with a fresh deletionId — FlowRoutes survive as orphans visible
in `getCanvas`, so an edit doesn't silently delete the user's wiring._

**Scene 2 — Draw the Connection.** User drags Web Server's output Port to API's
input Port. Today's `connectNodes`, unchanged. The new Connection renders with
a faint "no flows routed" pip.

**Scene 3 — Descend and refine.** User descends into Web Server.
`getCanvas({slug, canvasNodeId: webId})` returns:

```ts
{
  interiorNodes, interiorEdges, breadcrumbs,
  boundaryProxies: [{ nodeId: apiId, side: "remote" }],   // M3 derivation
  flowPalettes:    { [apiId]: Flow[] },                    // bundled, first 50 ops
  edgeFlows:       []                                      // none yet at this scope
}
```

The API renders as a read-only boundary proxy with its palette in a side
panel. User drops a `SearchHandler` Component, then **drags from
`SearchHandler`'s output Port directly onto the `POST /pets` palette item on
the boundary proxy**.

One mutation: `routeFlow({flowId, outerEdgeId, sourceNodeId: searchHandlerId})`.
The service:

1. Confirms the outer Edge exists and one of its endpoints is the Flow's owner.
2. Creates the inner Edge
   `(canvasNodeId: webId, sourceId: searchHandlerId, targetId: apiId)`. **This
   is the ONE place ADR-0005's same-Canvas rule loosens.** `apiId.parentId =
null` but the Edge sits on `webId`. The loosening is gated: `connectNodes`
   stays strict; only `routeFlow` may write a cross-scope Edge, and only when
   the cross-scope endpoint matches the outer Edge's boundary endpoint. New
   ADR-0012 documents this single exception.
3. Creates `FlowRoute { flowId, outerEdgeId, innerEdgeId: newInner.id }`.

All three writes share one transaction; the optimistic client sees them this
frame.

**Scene 4 — Back up.** User clicks the root breadcrumb.
`getCanvas({slug, canvasNodeId: null})` returns the existing payload plus:

```ts
edgeFlows: [{ edgeId: <web→api>, total: 14, routed: 1, unrouted: 13, orphan: 0,
              byKind: { OPENAPI_OPERATION: 14 } }]
```

The parent Connection renders with a **"1 / 14 routed"** pill. Clicking opens
an inspector listing routed/unrouted operations. Aggregation is one extra
`findMany + groupBy` joined into `getCanvas`'s existing `Promise.all` — **one
round trip preserved.**

**Scene 5 — SSE in the reverse direction.** User adds a Flow to the API:
`{key: "channel:tickUpdates", kind: SSE_STREAM, polarity: OUTBOUND}` (manually,
or via AsyncAPI spec). Palette is now 15 items.

User descends into Web Server, drops `TickConsumer`, drags the API boundary
proxy's `tickUpdates` palette item _to_ `TickConsumer`'s input Port. The canvas
detects: polarity is OUTBOUND, owner is API, existing outer Edge is web→api —
routing here would point the arrow backwards.

**One-click confirmation**: "This flow originates from the API. Add an API →
Web Server Connection to carry it?" On confirm, one batched mutation:

1. `connectNodes` creates the reverse outer Edge `(api → web, root)`.
2. `routeFlow` creates the inner Edge
   `(canvasNodeId: webId, sourceId: apiId, targetId: tickConsumerId)` plus the
   FlowRoute on the _new_ outer Edge.

Going back up, root Canvas now shows **two Connections** between Web Server
and API — `Web Server → API` "1 / 14 routed" and `API → Web Server` "1 / 1
routed". Two arrows, two stories, each enumerable. ADR-0009 vindicated.

## Multi-level invariants (service-enforced)

1. **Polarity must match the rendered arrow.** `OUTBOUND` Flow on an Edge where
   source ≠ owner is rejected. UI mediates with the reverse-Edge offer; service
   is the backstop.
2. **A FlowRoute's outerEdge must touch the Flow's owner** (source or target).
3. **A FlowRoute's innerEdge (when present) sits on a Canvas that is the
   interior of the outer Edge's _other_ endpoint** — i.e. inside the consumer
   (INBOUND) or producer (OUTBOUND). Its cross-scope end is a boundary proxy
   of the owner.
4. **`connectNodes` is strict, `routeFlow` is the only bounded-loose writer.**
   Reviewable invariant. Both share the same Edge de-dupe catch path —
   `routeFlow`'s inner-Edge `create` MUST run through `isEdgeDedupCollision`
   and translate to the same `ConflictError` shape (ADR-0010 names this
   second writer by name; convergence is correctness-defining, not cosmetic).
5. **No cycles in refinement chains.** Inner Edges can themselves be outer
   Edges deeper down (refinement all the way to function-level) — acyclic by
   construction since `canvasNodeId` strictly descends.
6. **Re-parsing a spec is non-destructive.** Matching keys preserved; dropped
   keys soft-delete with their own deletionId so FlowRoutes orphan visibly
   rather than vanish.

## Deletion semantics (ADR-0008 + ADR-0014 honored)

- `deleteNode(component)` cascade-sweeps: descendants, incident Edges, owned
  Flows, owned FlowSpec, FlowRoutes whose outerEdge or innerEdge sits in the
  swept set. One `deletionId`; `restoreNode` brings it all back.
- `deleteEdge(edge)` sweeps the Edge plus any FlowRoute referencing it as
  outer or inner. One `deletionId`; symmetric restore.
- `deleteFlow(flow)` soft-deletes the Flow and its FlowRoutes (owner-only,
  undoable).
- A FlowSpec re-parse soft-deletes per-key with a fresh deletionId per re-parse
  batch.

## Markdown / MCP (deterministic, addressable)

```markdown
## API (External API) {id:apiId}

### Flows (14 inbound from openapi; 1 outbound)

- INBOUND GET /pets (op:listPets) routed at: root → WebServer→API; refined at: WebServer → SearchHandler→API[boundary]
- INBOUND POST /pets (op:createPet) unrouted
- OUTBOUND channel:tickUpdates (sse) routed at: root → API→WebServer; refined at: WebServer → API[boundary]→TickConsumer
```

New MCP resources: `flow/:id`, `flow-route/:id`. New tools: `attach-flow-spec`,
`add-flow`, `route-flow`, `unroute-flow`, `list-flows`. The `apply-graph` batch
tool gains `flows:[]` and `routes:[]` arms. The `apply_graph` substrate itself
landed in #20 (Components + Connections); the additive `flows:[]` / `routes:[]`
arms remain Slice 5 / #38 work. All additive; the agent's mental model becomes
_"Components own contracts; Connections route them."_

## Performance posture

- `getCanvas` adds two reads to its `Promise.all`: a Flow `findMany` for
  boundary-proxy palettes on this scope, and a FlowRoute aggregation grouped by
  `outerEdgeId`. Still one round trip.
- Boundary-palette set per scope is bounded by _boundary proxies with
  spec-derived Flows_ (typically 1–2 per Canvas). For worst-case (200 ops per
  spec), the bundled palette ships the first 50 with `hasMore`, backed by a
  separate `getFlowPalette({ownerNodeId, cursor})` for the inspector.
- Spec parsing is **server-side only, parse-on-write into rows** — never on
  read. The OpenAPI body never travels with a Canvas read.
- N=1000 Components: per-Canvas palette is O(boundary proxies on this scope),
  not O(project). Safe.

## React Flow / canvas implications

- **New `boundary-proxy` node type** — read-only; renders kind icon, title,
  side handles, and a palette popover/sidebar.
- **`ComponentNode` unchanged** at the handle level (still input/output). New
  "flows" pill when it owns Flows; opens its palette in a detail panel for
  spec paste / Flow CRUD.
- **Palette-to-Port drags** synthesize the connection from polarity (INBOUND
  palette → drag child→proxy; OUTBOUND → drag proxy→child) and dispatch
  `routeFlow`.
- **New contexts** (mirror the rename/delete/descent pattern, inert by
  default): `AttachFlowSpecContext`, `AddFlowContext`, `RouteFlowContext`,
  `UnrouteFlowContext`. All disabled when `CanEditContext` is false.
- **Parent-arrow rendering**: `ConnectionEdgeView` reads `edgeFlows` from edge
  `data` (populated by `getCanvas`). Renders a count pill structurally;
  clicking opens an inspector.

## Implementation sequence (5 slices)

**Slice 1 — Flows on Components.** Schema additions (authored via
`pnpm db:author <name>`, which scaffolds the migration directory and seeds it
with the live-DB-to-schema diff — hand-edit for raw SQL Prisma cannot express,
then apply with `pnpm db:migrate`; the long-form `prisma migrate diff`,
`db push`, and `migrate dev` invocations are retired per ADR-0010 and commit
`b8305c6`), the `idx_flow_dedup` partial unique index + `isFlowDedupCollision`
helper, `attachFlowSpec` / `addFlow` / `updateFlow` / `deleteFlow` services
translating `P2002` to `ConflictError` with `details.conflictingFlowIds`,
cascade-sweep arms in `deleteNode`, paste-spec UI on the Component-detail
panel, the "N flows" pill on the Component body, Vitest at the service seam
(including a concurrency regression test for the new index, mirroring
`edge.service.test.ts`'s pattern), CONTEXT.md updates, and ADR-0011
("Flows as first-class, owned by Components") — landing here rather than
with Slice 3 per the "docs travel with code slices" convention (the
first-class-Flow decision is what this slice makes). **MCP tools split off
to a follow-up issue** gated on #18 so the slice can ship its schema +
service + UI without also waiting on the MCP route. **Ships value alone before
M3.** M3-independent.

**Slice 2 — Same-Canvas baseline routing.** `routeFlow` without inner edge
("this pipe carries this Flow"), the `idx_flow_route_dedup` partial unique
index + `isFlowRouteDedupCollision` helper + `details.conflictingFlowRouteIds`
on conflict, `edgeFlows` count in `getCanvas`, a "+ flow" affordance on a
selected Connection. The "draw Connection, see 14 flows available" moment.
M3-independent.

**Slice 3 — M3 boundary proxies + refinement.** _(Shipped: #36, absorbing #13
boundary derivation + #14 boundary-proxy rendering.)_ Boundary derivation
(transitive, derived-only, one recursive CTE in `getCanvas`), boundary-proxy
node type + Flow palette, `routeFlow` with inner edge (the gated ADR-0005
exception — ADR-0012 documents it). The inner-Edge write converges on
`idx_edge_dedup` via `createMany({ skipDuplicates })` (`ON CONFLICT DO NOTHING`)
so a shared inner Edge carries many FlowRoutes and the transaction is never
aborted — ADR-0010 names `routeFlow` as the second Edge writer that closes this
race. The sweep is reference-counted (a shared inner Edge dies only with its
last route). Drag-from-palette-to-child synthesizes the optimistic interior Edge

- FlowRoute. `getCanvas` gained `boundaryProxies` + `flowPalettes`, with
  `getFlowPalette` paging the overflow. MCP `route-flow` arg deferred to #42.
  **This is the delight slice.**

**Slice 4 — Bidirectional reconciliation.** Polarity validation in
`routeFlow`; the "create reverse Connection?" canvas UX; tests for
OUTBOUND-on-forward-edge rejection. SSE example fully works.

**Slice 5 — Aggregated parent rendering + markdown export.** `edgeFlows`
enriched (routed/unrouted/orphan), count pill + inspector on connection edge
view, deterministic serializer extended for Flows/Routes (contributes to M2),
MCP resources `flow/:id` / `flow-route/:id`. The curmudgeon's "yes."

## ADRs to write (per slice, not upfront)

> ADR-0010 was claimed by the Edge de-dupe partial-unique-index hardening
> (issue #25). The reservations below shift by one.

- **ADR-0011 — Flows as first-class, owned by Components.** Why Flow is its own
  row (not Edge metadata, not Component Ports). **Lands with Slice 1**
  (overrides the earlier "ADRs land per slice" sketch above — the architectural
  decision Slice 1 makes is exactly what ADR-0011 justifies, so it travels with
  the slice rather than being deferred).
- **ADR-0012 — `routeFlow` is the sole cross-scope Edge writer.** The single
  gated exception to ADR-0005. **Shipped with Slice 3** (`docs/adr/0012-…`).
- **ADR-0013 — Polarity, not stored direction.** Reaffirms ADR-0009; explains
  why bidirectional pipes are still two Edges. Lands with Slice 4.

## Open questions — resolved for Slice 1

All seven Slice-1 questions were resolved in issue #34, ADR-0011, and the
implementation that landed in PR #41. They are kept here as a record of where
each decision lives.

1. **Spec UI location** — Component detail side panel (sidebar, not modal). See
   ADR-0011 and `component-detail-panel.tsx`.
2. **User-authored Flows** — allowed (`sourceSpecId = null`). See `addFlow`
   service + ADR-0011.
3. **Polarity defaults** — `OUTBOUND` from the server end for WebSocket/EVENT;
   manual override available. See ADR-0011.
4. **Re-paste behavior** — non-destructive: matching keys preserved, dropped
   keys soft-deleted with a fresh `deletionId` per batch. See
   `reconcileDerivedFlows` in `flow.service.ts`.
5. **`Edge.label`** — kept. Names the pipe ("primary HTTPS"); per-Flow titles
   name the content.
6. **WebSocket modeling** — two Flows per WS (one INBOUND, one OUTBOUND). No
   `BIDIRECTIONAL` polarity.
7. **Markdown export of unrouted Flows** — deferred to Slice 5 (#38).

## What was rejected from the contributing plans, and why

- **`ComponentPort` as persisted rows** (Architect Plan A) — would force parent
  arrows to be a derived aggregation that rots. We keep spec-on-Component
  (Plan A's good idea) but materialize as `Flow` rows (Plan B's good idea).
- **One-Edge-two-arrowheads for bidi** (Architect Plan B) — direct conflict
  with ADR-0009. Master plan uses two Edges per direction with polarity-matched
  Flows on each.
- **Spec-in-`Node.documentation` + parse-on-read** (Engineer Plan B) — couples
  doc edits to read perf, OOM risk on hostile specs, hurts MCP ergonomics (no
  `list-flows` resource).
- **`Edge.content` as opaque JSON** (Engineer Plan B) — loses indexability,
  soft-delete granularity, MCP addressability.
- **"User manually draws reverse pipe; system warns"** (Architect Plan A) —
  friction. Master plan: one-click affordance when a polarity mismatch is
  detected.

## What was preserved, and from where

| Idea                                                      | From                       |
| --------------------------------------------------------- | -------------------------- |
| Spec is owned by the Component (FlowSpec on a Node)       | Architect A & Engineer A   |
| Flow is a first-class row                                 | Architect B & Engineer A   |
| FlowRoute binds outer Edge to inner Edge                  | Engineer A                 |
| `routeFlow` is the gated cross-scope writer               | Engineer A                 |
| Polarity (owner-derived per-Flow direction)               | Engineer A (named clearly) |
| Re-paste soft-deletes dropped keys; routes orphan visibly | Engineer A                 |
| Sliced migration plan                                     | Engineer A                 |
| "Two Connections for two-way is already the law" anchor   | Engineer B                 |
| Refinement-chain coherence rule (descendant of ancestor)  | Architect B                |
| Aggregation lives in `getCanvas`, one round trip          | Both engineer plans        |
