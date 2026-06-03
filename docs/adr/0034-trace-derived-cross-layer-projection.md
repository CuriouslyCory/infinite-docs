# 34. Trace is a derived cross-layer projection: persist the point set, recompute the on-path subgraph; read-only auto-laid-out nested render

## Status

Accepted (#58).

**Builds on** [ADR-0031](0031-cross-scope-read-derivation-and-per-edge-boundary-proxy.md):
the Trace view shows every layer at once, so it does NOT reuse `getCanvas`'s
per-scope boundary-proxy reprojection — every Connection endpoint has a real box
on screen, so the derived Trace edges carry the **real** `sourceId`/`targetId`,
not the `*Repr` projection. The cross-scope-derivation lineage is shared (both
read the unified graph), but the on-path projection is its own read.

**Builds on** [ADR-0001](0001-service-layer-db-actor-input.md): `getTraceView`
follows the `(db, actor, input)` service contract with a narrow, required Zod
input (`{ slug, nodeIds }`); it fetches the node + edge universe in one
`Promise.all` round trip (no waterfall).

**Builds on** [ADR-0004](0004-server-client-boundary-and-island-types.md): the
render is a separate `ssr:false` React Flow island; dagre and the layout helper
are client-only, imported only inside the island; the client consumes the
derived shape through `~/lib/types` via top-level `import type` (never
`~/server`).

**Builds on** [ADR-0006](0006-recursive-ancestry-walks.md): the nesting-ancestor
closure (climb `parentId` so every on-path Component renders inside its boxes) is
the same ancestry walk `getCanvas`'s breadcrumb CTE performs, but here it is a
pure in-memory climb over the already-fetched node map, bounded by the same
`ANCESTRY_DEPTH_CAP`.

**Honours** [ADR-0002](0002-capability-slug-read-grant.md): the read is
slug-bound — possession of the capability slug IS the read grant.

## Context

Issue `#57` shipped the **working trace**: a per-Project, client-only set of **trace
point** Node ids in `localStorage`, plus the working-set manager / empty state.
The cross-layer derivation and render were explicitly deferred to this slice.

The goal: given 2+ trace points, render every **Component** and **Connection**
lying on a path between them, **expanded across all layers at once** (nested
boxes, all scopes visible simultaneously), auto-laid-out, read-only.

Three load-bearing facts shaped the design:

1. **The issue's "ADR-0025" is stale** — ADR-0025 is already the flowspec parser
   registry; the highest existing ADR was 0033. This is **ADR-0034**.

2. **The issue's "cross-scope FlowRoute inner edges" no longer exist.** The Flow
   model and its inner-Edge writer (`routeFlow`) were retired in #62
   ([ADR-0030](0030-cascade-undo-without-flowroutes.md)). There is no FlowRoute
   table and no inner-edge rows. A cross-scope Connection is just an ordinary
   `Edge` whose endpoints have different `parentId` ancestry — already in the
   Edge set. **Building a FlowRoute join would query a dropped table.**

3. **The issue's "authorize with `assertCanRead`" is realized as the established
   slug-bind gate**, in parity with `getCanvas` and every other slug-readable
   read: the `db.project.findFirst({ where: { slug, deletedAt: null } })` bind IS
   the authorization, and the `_actor` is accepted only to match the
   readable-procedure signature, never consulted. Both the owner and a slug-only
   viewer reach the read via the slug (the issue's "owner and slug-only viewer"
   criterion). Introducing a divergent `assertCanRead` re-fetch of `ownerId`
   would break parity with `getCanvas`.

## Decision

**A Trace is never stored as a subgraph — only the trace-point set is (a point
set, in a later slice, #59). The on-path union over the unified undirected
(Connection ∪ nesting) graph is recomputed on every read by `getTraceView`,
capped at 500 Components with a surfaced truncation warning, and rendered
read-only as a dagre-auto-laid-out nested-box React Flow island.**

### The unified undirected graph

`V` = all live Nodes in the Project. `E` = exactly:

- (a) every active Edge `(sourceId, targetId)` treated **undirected** (the issue
  derives reachability over the whole graph as undirected), PLUS
- (b) a nesting link `(child, parent)` for every live Node with a live
  `parentId`.

There is **no third "FlowRoute" edge class** — see Context fact 2.

### The on-path characterization (block-cut tree, NOT path enumeration)

A vertex/edge is *on a path between A and B* iff it lies on **at least one simple
path** from A to B. Enumerating simple paths is NP-hard. The correct polynomial
equivalent: within a **biconnected-component decomposition**, a vertex `v` lies
on some simple A–B path **iff** `v` is in a block on the A–B path of the
**block-cut tree**. The Trace subgraph is the union, over every unordered pair of
valid trace points, of all blocks on that pair's block-cut-tree path, plus each
included Component's nesting ancestors. This is O(V+E) for the decomposition,
**terminates** (no path enumeration), and a disconnected pair contributes nothing
(no tree path).

### App-code over a recursive CTE for the on-path core

The fetch is two flat indexed `findMany`s (no CTE needed). The block-cut
decomposition is computed in TypeScript — an **iterative** (explicit-stack)
Tarjan BCC, pure and isolated — because: (1) block-cut decomposition is not a
single terminating recursive SQL query without the same NP-hard pitfall the cap
guards; (2) `pnpm check` cannot see into raw SQL, and the on-path correctness is
the riskiest logic, so it belongs where it is type-checked and unit-testable; (3)
the nesting-ancestor climb is a pure in-memory walk over the already-loaded node
map. The recursive CTE is cited as the established ancestry-walk precedent
(ADR-0006), not literally re-run.

### The cap is a truncate, not a throw

`TRACE_NODE_CAP = 500` is enforced on the accumulated on-path node set (including
ancestors). On overflow the service sorts by id (so truncation is deterministic),
slices, keeps only Connections whose **both** endpoints survive, and returns
`truncated: true` + a `warning` string. It **never hangs and never throws** —
distinct from `getCanvas`'s depth-cap *throw*; here truncation is a normal,
user-visible outcome, surfaced as a non-blocking banner. The Zod input also caps
`nodeIds` at 500 (defense in depth).

### dagre over elkjs for layout

The nesting is a strict `parentId` **tree** we already own, so we lay out each
scope's siblings with dagre and size each parent container to its children's
bounding box ourselves — we do NOT need elk's compound-graph auto-nesting. dagre
(`@dagrejs/dagre`, the maintained fork, pinned 3.0.0) is synchronous and far
leaner than elk's async worker bundle — both matter for a lazily-loaded
`ssr:false` island (performance philosophy #1).

### Read-only for everyone

The render is read-only even for the owner: `nodesDraggable={false}`,
`nodesConnectable={false}`, `deleteKeyCode={null}`, no connect/delete/drag/edit
handlers. Clicking a leaf Component opens the existing `ComponentDetailPanel`'s
`readOnly: true` arm (docs read-only, no edit affordances) plus a **"Go to
canvas"** jump to that Component's real layer (its parent's interior canvas
`/p/[slug]/n/[parentId]`, or `/p/[slug]` at the root).

## Consequences

- `getTraceView(db, actor, { slug, nodeIds })` is a new public, slug-readable
  query in the architecture router, modeled on `getCanvas`. Stale / foreign /
  soft-deleted trace-point ids are silently dropped; below two survivors it
  returns the empty shape and the client shows the insufficient-points state.
- The BCC, on-path union, and ancestor-climb are factored as pure exported
  functions so they are unit-testable if/when a harness lands (there is no test
  runner today; `pnpm check` is the gate).
- The Trace node payload carries `documentation` (bounded by the 500 cap) so the
  read-only detail panel opens with no click-time round trip (perf philosophy
  #1) — a deliberate widening of the issue's `{ id, title, kind, parentId }`
  sketch, justified by avoiding a per-click waterfall. It also carries
  `isTracePoint` so the render highlights the endpoints distinctly from
  path-only intermediaries and ancestor-only container boxes.

## Out of scope (explicit seams)

- **#59 — persistence.** The `Trace` Prisma model, migration, save/load/share,
  named Traces, and the saved route. #58 adds **no schema, no DB write, no
  save/load** — `getTraceView` computes purely from the in-memory `nodeIds`.
- **#60 — MCP trace resource + serializer trace mode.** #58 does not touch
  `markdown.ts`, `export.service.ts`, the MCP path, or `/llms.txt`. The Trace
  render is a React Flow view, not a markdown projection.
