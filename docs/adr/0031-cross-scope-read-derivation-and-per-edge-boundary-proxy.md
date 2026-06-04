# 31. Cross-scope rendering: `getCanvas` derives each endpoint's on-scope representative; a boundary proxy is a per-edge stand-in

## Status

Accepted (#63).

**Builds on** [ADR-0028](0028-cross-scope-connections-lineal-ingress.md): #62
accepted cross-scope and lineal Connections at write time and dropped
`Edge.canvasNodeId`, explicitly deferring "which scope(s) does this Edge appear
on" — and the boundary-proxy rendering it feeds — to #63. This ADR is that read
derivation. **Builds on** [ADR-0027](0027-connection-carries-its-own-interaction.md):
the derived edge row carries `interaction` unchanged; arrowhead derivation from
`(interaction, source, target)` is #65's domain, not this ADR's.

**Completes the supersede** of [ADR-0005](0005-edge-scope-and-service-enforced-invariants.md)
begun by ADR-0028: ADR-0005's stored-scope endpoint model is fully replaced —
scope is _derived from endpoint ancestry_, here, at read time. **Completes the
supersede** of [ADR-0012](0012-routeflow-sole-cross-scope-edge-writer.md): its
writer was deleted in #62; its boundary-endpoint _read_ derivation is replaced
here.

**Supersedes the boundary-group half** of
[ADR-0016](0016-passive-nodes-and-boundary-group-n1-stability.md): the transitive
boundary-group container, its `origin: "direct" | "inherited"` partition, and the
"keep that partition stable" reviewable invariant are retired. ADR-0016's
**passive-node taxonomy survives unchanged** — the boundary proxy IS a passive
kind, and `isPassiveNode` + the `CanvasRFNode` exhaustiveness remain the extension
point (the client rendering is #65).

**Amends** [ADR-0001](0001-service-layer-db-actor-input.md): `getCanvas` grows a
fourth derived field but stays a single round trip (one more concurrent read in
the same `Promise.all`). **Amends** [ADR-0006](0006-breadcrumbs-single-recursive-query.md):
the recursive-CTE / raw-SQL discipline now applies in a third place
(`getCanvas`'s cross-scope derivation, alongside its breadcrumb CTE and
`export.service.ts`'s subtree walks) — "the repo's only raw SQL" is long since
plural.

## Context

After #62 a Connection may link any two Components at any scope, but `getCanvas`
still filtered its interior Connections to edges with BOTH endpoints' `parentId`
equal to the scope. A cross-scope Connection therefore rendered on _neither_
endpoint's Canvas — it vanished. The motivating user need ("wire a Component to
one in another subtree and see it on both sides") was invisible.

A Connection should be visible at every **altitude** where it is meaningful: on
each endpoint's own Canvas (the far end shown as a stand-in), and on any
common-ancestor Canvas (both ends shown as the ancestor Components that contain
them). Because an Edge stores no scope (ADR-0028), this is a derivation over the
endpoints' `parentId` ancestry, not a stored column.

The pre-#62 **boundary proxy** (ADR-0012/0016) was a _transitive_ construct: an
external a Component connected to on its parent Canvas, projected inward and
inherited down the subtree, partitioned into `direct` vs `inherited`, and
collapsed into a boundary group. That whole model died with the Flow capability
model. The replacement is far simpler and per-edge.

## Decision

### The rendering rule (`rep(N, S)`)

For scope `S` (a Node id, or `null` for the Project root) and an active Edge
`E = (A, B)`, let `rep(N, S)` be the ancestor of `N` whose parent is `S`:

- `rep(N, S) === N` when `N.parentId === S` (N is interior to S);
- `rep(N, S)` is the intermediate ancestor on the path `N → … → S` whose parent
  is `S`, when S is deeper in N's chain;
- `rep(N, S)` is **absent** when S is not on N's ancestor chain (including
  `N === S` itself — S is not a strict ancestor of itself).

With `a = rep(A, S)`, `b = rep(B, S)`:

- **both present, `a ≠ b`** → an interior edge between real Nodes `a` and `b`
  (same-Canvas when the reprs equal the endpoints; the **altitude** view when
  they are ancestors).
- **exactly one present** → an interior edge from the on-scope real Node to a
  **boundary proxy** of the off-scope endpoint.
- **both present and `a == b`, or neither present** → not rendered on `S`.

### Worked example — the lineal (ingress) case

A parent→child Connection `E = (parent, child)` with `child.parentId === parent`
is lineal ingress (ADR-0028). Its rendering is the example most worth pinning
down, because the prose is easy to misread:

- **On `S = parent`** (the parent's interior Canvas — which is the **child's home
  Canvas**): `rep(parent, parent)` is absent (parent is not its own ancestor),
  `rep(child, parent) === child`. Exactly one present → the real `child` is drawn
  with a **boundary proxy of `parent`** as the other end. This is what "a lineal
  Connection renders as boundary-proxy-of-ancestor → descendant on the
  descendant's home Canvas" means — **home Canvas, i.e. the parent's interior
  Canvas**, never "inside the child" (the child's _own_ interior Canvas has
  nothing to render for this edge).
- **On `S = root`** (parent at the root): `rep(parent, root) === parent`,
  `rep(child, root) === parent` (the child's ancestor whose parent is null is the
  parent). Both present, `a == b` → collapse, not rendered.

### Derived in one recursive CTE, in a single round trip

The derivation is ONE recursive ancestry CTE (`endpoint_walk`) that, for both
endpoints of every active Edge in the Project at once, climbs `parentId` toward
the scope — stopping at the representative (the node whose parent is `S`) — and a
final join that emits, per edge, `(source_rep, target_rep)`. It runs concurrently
with the interior-Nodes read and the breadcrumb CTE inside `getCanvas`'s existing
`Promise.all`, so the read stays a single round trip (ADR-0001). The SQL filter
drops the collapse (`a == b`) and not-rendered (neither present) cases; the
service splits each surviving row into an interior edge ± one boundary proxy.
Only Edges whose **both** endpoints are live are considered — a soft-deleted
endpoint hides the Connection, the same posture the prior interior-edges relation
filter had.

### The return shape

`getCanvas` returns `{ interiorNodes, interiorEdges, boundaryProxies, breadcrumbs }`.

- Each `interiorEdges` row is `{ id, sourceId, targetId, sourceRepr, targetRepr,
interaction, label }`. `sourceId`/`targetId` stay the real endpoints; the
  `*Repr` fields resolve each end onto this scope (the real Node, an ancestor for
  the altitude view, or the off-scope end's boundary-proxy synthetic id). The
  reprs are a per-scope read-time projection, never stored on the Edge.
- Each `boundaryProxies` row is `{ nodeId, title, kind, realEndpointId, edgeId }`
  — **one row per crossing edge**. `nodeId` is the synthetic stand-in id
  (`proxy_<edgeId>`); `realEndpointId` is the real off-scope Node it stands in
  for; `title`/`kind` are that Node's. A Component reached as the far endpoint of
  three crossing Connections produces three proxy rows that share
  `realEndpointId` but each carry a distinct `nodeId`, so React Flow keys never
  collide and a proxy stays addressable by the edge that produced it. Visual
  coalescing (drawing those three as one node) is a render-time choice the canvas
  client owns (#65), never a data-layer de-dupe.

### Loud truncation extends to the new walk

The connection-ancestry walk is depth-capped at `ANCESTRY_DEPTH_CAP` (256, shared
with the breadcrumb walk; cycles are impossible per ADR-0024, so the cap is a
recursion fuse). A walk clipped by the cap leaves a representative silently
absent, which would drop a Connection from the Canvas — so a clip is surfaced as
a typed `ValidationError`, the boundary-proxy analogue of the breadcrumb
truncation (ADR-0006). The two carry **distinct messages** so the cause is
unambiguous.

### Scope of this ADR (and the export's lingering shape)

This ADR governs the **`getCanvas`** read shape only. The markdown export's
boundary derivation (`export.service.ts`) still carries a _different_ shape
today — a subtree-incident `origin: "direct" | "inherited"` set — and its rewrite
to the per-edge model is #67 (which amends ADR-0017). A reviewer should **not**
flag the export's surviving `origin` field as an ADR-0031 violation pending #67;
the two derivations are intentionally separate (one walks endpoint ancestry
across the whole Project, the other walks a subtree under a root), serve
different consumers, and are not to be DRY'd into one CTE.

## Consequences

- **Reviewable invariant:** the cross-scope derivation is ONE recursive CTE in a
  single round trip. Re-introducing a stored `Edge.canvasNodeId`, or splitting the
  walk into a per-endpoint / per-level query, regresses this ADR (it inverts
  ADR-0005 the same way ADR-0028 first did).
- **Reviewable invariant:** a `boundaryProxies` row's DERIVED identity is exactly
  `{ nodeId, title, kind, realEndpointId, edgeId }`. Re-introducing `origin`,
  `isDirect`, `inherited`, or any transitive-projection field regresses this ADR.
  _(Realized in #91 → [ADR-0036](0036-boundary-proxy-placement-persistence.md):
  the row gains additive nullable `posX`/`posY` — a persisted view coordinate
  joined from a separate table — which leaves the five derived fields frozen and
  is NOT a transitive-projection field.)_
- **Reviewable invariant:** boundary proxies are **per crossing edge** — the data
  layer never de-dupes them by far Node. Visual coalescing belongs to the canvas
  client (#65).
- **Reviewable invariant:** the depth-cap truncation is loud for the
  connection-ancestry walk too — a clip throws, never silently drops a
  Connection.
- **The boundary proxy's IDENTITY persists no rows.** It is derived on every read;
  no `BoundaryProxy` table exists or should be added, and a proposal to materialize
  the _identity_ (title/kind/realEndpointId/edgeId) would regress the "derived, not
  stored" posture this ADR shares with ADR-0016's passive-node design. _(Realized in
  #91 → [ADR-0036](0036-boundary-proxy-placement-persistence.md): a separate
  `BoundaryProxyPlacement` table persists ONLY a per-scope view coordinate, keyed by
  `(containerNodeId, realEndpointId)` and joined back as the additive nullable
  `posX`/`posY` above. This does not materialize the proxy — the proxy still exists
  iff the cross-scope derivation emits it — so the "derived, not stored" identity
  invariant holds; ADR-0036 reconciles the two.)_
- **`pnpm check` cannot see into raw SQL** (ADR-0006): a wrong identifier or a
  rep-math error passes ESLint and `tsc` and fails only at runtime, so this
  slice's correctness rests on the service tests running against real Postgres
  (ADR-0003) — all four branches (same-Canvas, altitude, far-end proxy, collapse)
  plus lineal ingress, the per-edge proxy multiplicity, the soft-deleted-endpoint
  omission, and the depth-cap throw are asserted there.
- **`interiorEdges` narrows from the full Prisma `Edge` to `CanvasInteriorEdge`**
  (no `projectId` / timestamps / `deletedAt` / `deletionId` on the wire) and gains
  `sourceRepr` / `targetRepr`. The client consumes it by inference
  (`RouterOutputs`), never by importing the row type (ADR-0004); the optimistic
  same-Canvas writer sets the reprs to the endpoint ids directly.
- **#65 consumes this shape**: it renders the interaction-derived arrowheads, the
  boundary proxies as passive nodes with a "descend to real endpoint" affordance,
  and the altitude distinction (discovered from `sourceRepr !== sourceId`). #63
  lands the data; the canvas does not yet draw the new rows.

## Realized in #65

The canvas now consumes this shape (it previously ignored `boundaryProxies` and
the `*Repr` fields). `toRFEdge` attaches each Connection to `sourceRepr`/`targetRepr`
(not the raw endpoint ids); `boundaryProxies` seed as `boundary-proxy` passive
nodes. The frozen 5-field proxy row was **not** changed: "descend to real endpoint"
navigates to the off-scope Component's **own scope** (`/p/[slug]/n/[realEndpointId]`,
the meaning of "a node's scope" everywhere in this codebase), so no `parentId`-class
field was added. The lineal/ingress case is detected client-side — a proxy whose
`realEndpointId` is on the scope's breadcrumb trail — and labelled as an inbound
boundary; no server data carries the distinction. Per-edge proxies rendered
individually in this slice (no visual coalescing then, as ADR-0031 sanctions).

**Render-time coalescing later landed in #90:** the canvas seed groups per-edge
proxy rows by `realEndpointId` and draws ONE node per off-scope Component, routing
every crossing edge to it (a `proxy_<edgeId>` → representative remap threaded
through `toRFEdge`). This exercises the client-owned coalescing this ADR explicitly
left open (Decision §"The return shape"; Consequences invariant 3) — it supersedes
the "render individually" sentence above but changes nothing below the seed: the
service still emits one row per crossing edge, the `{ nodeId, title, kind,
realEndpointId, edgeId }` shape and `proxy_<edgeId>` id are unchanged, and the
query-cache mirror stays strictly per-edge so a remount re-seeds from authoritative
per-edge data and the ADR-0032 `temp_ → real` reconcile still keys on `proxy_<edgeId>`.
