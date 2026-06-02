# 32. The "Connect to…" gesture: node/project-keyed reads, a complete connection list, and a client-derived optimistic cross-scope insert

## Status

Accepted (#66).

**Builds on** [ADR-0031](0031-cross-scope-read-derivation-and-per-edge-boundary-proxy.md):
the canvas already renders cross-scope Connections and per-edge boundary proxies
from `getCanvas`'s `rep(N, S)` derivation. #66 adds the _gesture that creates_
such a Connection without both endpoints on screen, and reuses the SAME
`rep(N, S)` partition — here computed client-side for the optimistic insert.
**Builds on** [ADR-0028](0028-cross-scope-connections-lineal-ingress.md):
`connectNodes` stays the sole Edge writer and already accepts cross-scope and
lineal endpoints; this slice adds no write path. **Amends**
[ADR-0001](0001-service-layer-db-actor-input.md): two new single-round-trip
reads join the service layer. **Honours**
[ADR-0002](0002-capability-url-sharing.md): both reads are slug-readable.

## Context

After #65 a Connection can link any two Components at any scope and the canvas
draws the cross-scope result — but the only way to _draw_ one was dragging
between two Ports, which are never both on screen across scopes. #66 closes that
with a search-first gesture and a Connections section in the Component-detail
panel. Three questions fell out:

1. **What read powers the project-wide search?** `getCanvas` is scope-keyed (one
   Canvas); the search needs every Component in the Project.
2. **What does the panel's connection list show?** The Connections visible on the
   current Canvas (`getCanvas.interiorEdges` incident to the Component), or the
   Component's _complete_ connectivity?
3. **How is the optimistic cross-scope insert reconciled?** A cross-scope connect
   should show the far-end proxy instantly, but where it lands on the current
   scope depends on `rep(target, S)`, which the canvas does not trivially know.

## Decision

### Two reads, deliberately distinct from `getCanvas`

`listProjectComponents` (project-keyed) returns every live Component flat as
`{ id, title, kind, parentId }`; `listNodeConnections` (node-keyed) returns every
active Connection incident to one Component. Neither is folded into `getCanvas`'s
cross-scope CTE — they have different cardinality (the whole Project, or one
Component's incident edges, vs one Canvas) and different consumers. The flat
`parentId` on `listProjectComponents` lets the client rebuild each Component's
ancestor path (for search disambiguation) and resolve `rep(N, S)` (below) with no
server walk: a live Node's ancestors are always live, so the chain is intact in
the result. Both are slug-readable (ADR-0002), so a viewer reads the list.

### The panel's connection list is COMPLETE across scopes

The Connections section lists a Component's connections from `listNodeConnections`
(all active incident edges, far end resolved to its display fields), **not** a
scope-relative filter of `getCanvas.interiorEdges`. The difference is real: a
Connection from a Component to its own descendant is _lineal ingress_ — it
collapses on the Component's home Canvas (both `rep`s equal the Component, so
`getCanvas` draws nothing there; ADR-0031), and a scope-relative list would hide
it. The whole point of #66 is cross-scope connectivity, so the list shows the
Component's true connectivity regardless of which Canvas renders each edge.

### The optimistic cross-scope insert derives `rep(N, S)` on the client

`commitConnect` inserts the new Connection (and, when the far end is off-scope,
its boundary proxy) optimistically, then reconciles `temp_ → real` ids on the
mutation's success. Two facts shape the reconcile:

- **The React Flow store is seeded once** (ADR-0004) and is **not** re-seeded by a
  query refetch. So invalidating `getCanvas` after the write would refresh the
  cache mirror but leave the live store showing `temp_`/`proxy_<temp>` ids — a
  manual `temp → real` reconcile of the store is required regardless (exactly as
  the same-Canvas drag path in `handleConnect` already does).
- **The ancestry needed to place the edge is already on the client.** The palette
  fetched `listProjectComponents` (every Node's `parentId`) to populate the
  search, so `commitConnect` resolves the target's on-scope representative with
  the SAME `rep(N, S)` rule `getCanvas` derives server-side — for free, from cache:
  - target rep absent → off-scope: real-source → far-end **proxy**;
  - target rep is the source → lineal to our own descendant: it **collapses** on
    this scope, so it is added to the Connections list only, never the Canvas;
  - else → a plain interior edge to that representative (a real Node, possibly an
    ancestor for the altitude view), **no proxy**.

Computing `rep` client-side makes the optimistic render correct in _all four_
cases live, where an invalidate-only reconcile would have shown a far proxy for
the altitude case until the next remount. The per-edge proxy id is `proxy_<edgeId>`
on both the optimistic and the server side, so a later scope remount reconciles
without a flicker. New Connections default to `ASSOCIATION`; the interaction is set
afterward through the #65 picker (drawing a directional Connection up front — which
would grow the directional de-dupe arm in `~/lib/connection-rules.ts` — is deferred).

## Consequences

- **Reviewable invariant:** `listProjectComponents` and `listNodeConnections` are
  separate single-round-trip reads, never folded into `getCanvas`'s CTE
  (ADR-0031). Re-deriving the panel list from `getCanvas.interiorEdges` regresses
  the "complete across scopes" decision.
- **Reviewable invariant:** `connectNodes` remains the sole Edge writer (ADR-0028);
  the gesture is a thin caller with no new server write path or de-dupe logic.
- **Reviewable invariant:** the client optimistic insert's `rep(N, S)` math mirrors
  `getCanvas`'s server derivation, and the per-edge proxy id is `proxy_<edgeId>` on
  both sides. A client partition that diverges (e.g. always proxying the far end)
  would desync the store from a remount's authoritative render.
- **`pnpm check` cannot see the `rep` math** any more than it sees `getCanvas`'s
  raw SQL (ADR-0006/0031). The two reads' correctness rests on service tests
  against real Postgres (ADR-0003) — same-Canvas, cross-scope, and lineal incident
  edges; soft-deleted edge and far endpoint omitted; not-found slug — and the
  optimistic UI on the dev-browser end-to-end check.
- **Slug-readable, viewer-safe:** the Connections list renders for a capability
  viewer; the "Connect to…" add affordance is owner-only and _omitted_ (not
  disabled) in viewer mode, the panel's existing dual-audience convention
  (ADR-0002).
- The palette pre-excludes the Component itself and its already-connected far ends,
  so the default ASSOCIATION gesture can't pick a target that would just bounce off
  the de-dupe; the service `ConflictError` remains the backstop for a concurrent
  racer (ADR-0010).
