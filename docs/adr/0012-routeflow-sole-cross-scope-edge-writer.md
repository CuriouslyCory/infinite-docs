# 12. `routeFlow` is the sole cross-scope Edge writer

## Status

Accepted (Slice 3 of flow-routed-connections). Amends
[ADR-0005](0005-edge-scope-and-service-enforced-invariants.md) (the explicit
`canvasNodeId` Edge scope and the same-Canvas invariant) — which already
anticipated this loosening — and builds on
[ADR-0010](0010-edge-dedup-partial-unique-index.md) (the `idx_edge_dedup`
partial unique index), [ADR-0011](0011-flows-as-first-class-component-owned.md)
(Flows as first-class), and [ADR-0014](0014-deleteedge-restoreedge-cascade.md)
(the cascade whose forward-compat `innerEdgeId` arm this slice finally
exercises). ADR-0005's Status block points here.

## Context

Slice 3 is the refinement slice: descend into a Component, see the externals it
connects to as read-only **boundary proxies**, and drag one of a proxy's
**Flows** onto a child Component to say *"this Flow, one scope deeper, continues
as this interior Connection."* That binding is a **FlowRoute** whose
`innerEdgeId` finally points at a real **Edge** — the **inner Edge** between the
child and the boundary proxy.

That inner Edge is the one place the system must write an Edge whose endpoints
sit at **different scope levels**: the child lives on the current Canvas
(`parentId === canvasNodeId`), but the boundary proxy is the real external
Component, which lives higher up (`parentId !== canvasNodeId`). ADR-0005 made
Edge scope an *explicit, recorded* `canvasNodeId` precisely so this could exist
with no schema change — and said in as many words that "only the validation rule
will loosen." This ADR records that loosening and the four judgment calls it
forced, none derivable from ADR-0005 alone:

1. **Who may write a cross-scope Edge, and how is the loosening bounded** so it
   does not become a hole in the same-Canvas invariant?
2. **How is the inner-Edge write made race-safe** under `idx_edge_dedup`, given
   that two refinements of the same outer Edge legitimately *share* one inner
   Edge rather than conflicting?
3. **What sweeps a shared inner Edge**, when an Edge is now a pipe that several
   FlowRoutes may ride?
4. **Where does boundary derivation live**, and does it write anything?

## Decision

### `routeFlow` is the only cross-scope Edge writer; `connectNodes` stays strict

The cross-scope Edge write lives in exactly one function — `routeFlow`'s
`resolveInnerEdgeId`. `connectNodes` keeps ADR-0005's assertion verbatim (both
endpoints' `parentId` must equal `canvasNodeId`). **"`connectNodes` is strict;
`routeFlow` is the only bounded-loose writer" is a reviewable invariant** — a
future change that loosens `connectNodes`, or that writes a cross-scope Edge from
any other service, regresses ADR-0005. A regression test pins it
(`connectNodes still rejects a cross-scope endpoint`).

### The loosening is bounded to the derived boundary endpoint

`parentId !== canvasNodeId` is permitted for an inner-Edge endpoint **iff** that
endpoint is the **boundary endpoint** — and the boundary endpoint is *derived,
never taken from input*. `routeFlow` accepts `{ flowId, outerEdgeId,
sourceNodeId?, targetNodeId? }`; it computes the boundary endpoint `B` as the
Flow's owner (already required, by the touches-endpoint invariant, to be an
endpoint of the outer Edge) and requires that exactly one of the supplied
endpoints equals `B`. The other is the **interior endpoint**, which must be a
child of the outer Edge's *other* endpoint (the Canvas the inner Edge sits on).
Because no input names `B` directly — the client supplies two endpoint ids and
the service pins one of them to the derived owner — a caller **cannot smuggle an
arbitrary foreign Node in as the cross-scope endpoint**. There is no
`innerEdgeId` input: the service computes it. The `routeFlowInput` schema stays
narrow (both endpoints or neither), per "prefer narrow required inputs."

This slice is **direction-blind**: it writes `sourceId`/`targetId` exactly as the
UI synthesises them and does not check that the Flow's polarity matches the arrow
(`INBOUND ⇒ owner is target`, `OUTBOUND ⇒ owner is source`). That refinement, and
the reverse-Connection offer for a mismatch, are Slice 4 (ADR-0013). Obvious
mismatches surface as server errors, not silent writes.

### Find-or-create via `ON CONFLICT DO NOTHING`, not a retry loop

Two concurrent `routeFlow` calls refining the **same** outer Edge with
**distinct** Flows over the **same** `(interiorEndpoint, boundaryEndpoint)` pair
must converge on **one shared inner Edge carrying two FlowRoutes** — an Edge is a
pipe that carries many Flows, and `FlowRoute.innerEdgeId` has no uniqueness by
design. So the inner-Edge write is **find-or-create**, not the reject-on-dup that
`connectNodes` does.

It is implemented with `db.edge.createMany({ data: [...], skipDuplicates: true })`
— which emits `INSERT … ON CONFLICT DO NOTHING` — followed by a read-back of the
surviving row. This is deliberate over a bare `create` with a `P2002` catch:
`ON CONFLICT DO NOTHING` **never raises**, so it **never aborts the surrounding
transaction**. A bare `create` that hit `idx_edge_dedup` inside the FlowRoute
transaction would poison it (Postgres marks an aborted transaction unusable), and
the catch-then-re-query convergence pattern `connectNodes` uses only works
*outside* a transaction. The `createMany` form lets the inner Edge and the
FlowRoute commit **atomically in one transaction with no retry loop**. This names
`routeFlow` as the **second writer that closes the `idx_edge_dedup` race**
(ADR-0010 anticipated a second adopter); convergence here is correctness-defining,
not cosmetic. The FlowRoute write uses the same `createMany` form — a `count === 0`
result is the concurrent-duplicate signal that re-reads for the readable
`ConflictError { conflictingFlowRouteIds }`, with the pre-check `findFirst`
serving the common sequential case.

### A shared inner Edge is swept only when no other active FlowRoute references it

Because inner Edges are shared, the cascade is **reference-counted**, not
one-to-one. `unrouteFlow` sweeps a FlowRoute's inner Edge **only when no *other*
active FlowRoute references it** (the count excludes the row being deleted); when
it does sweep, it mints one `deletionId` and stamps both rows so `restoreEdge`
revives them as a unit, otherwise it is a lone soft-delete with no `deletionId`
(ADR-0008's lone-delete rule). `deleteEdge`'s cascade (ADR-0014) gains the same
rule: sweeping an outer Edge sweeps its FlowRoutes, and each inner Edge they
carried **only when no surviving active FlowRoute still references it**.
`restoreEdge` revives by `deletionId` and so brings the inner Edge back with its
routes. **"A shared inner Edge survives as long as one active FlowRoute rides it"
is a reviewable invariant**, pinned by tests.

### Atomicity is a caller-supplied transaction

`routeFlow` (inner-Edge write + FlowRoute write) and `unrouteFlow` (FlowRoute
sweep + conditional inner-Edge sweep) are multi-write and **rely on the caller to
wrap them in `db.$transaction`** — the tRPC procedures now do, matching the
`deleteEdge`/`restoreEdge` precedent (ADR-0014). The `createMany` writes never
abort the transaction, so no caller-side retry is needed.

### Boundary derivation is a derived view, written by no one

Boundary proxies (#13/#14) are computed transitively —
`boundary(H) = directBoundary(H) ∪ boundary(H.parent)` — by a single recursive
CTE folded into `getCanvas`'s existing `Promise.all` (the breadcrumb-query shape,
ADR-0006), so the single-round-trip read holds (ADR-0001). **No rows are
persisted** for a proxy; like the Canvas itself, it is a derived view. Each
in-scope proxy's first page of Flows ships in the same query as `flowPalettes`
(a correlated `json_agg`); the remainder pages in through `getFlowPalette`. Only
a **direct** proxy (the scope connects to it on its own parent Canvas) is
routable here — it carries the `outerEdgeId` a palette drag refines; an inherited
proxy is context-only, routed at the scope where the direct Connection lives.

## Consequences

- **"`routeFlow` is the sole cross-scope Edge writer; `connectNodes` stays
  strict" is a reviewable invariant.** Any other cross-scope Edge write, or a
  loosened `connectNodes`, regresses ADR-0005.
- **The cross-scope endpoint is derived, never input.** A reviewer must keep the
  boundary endpoint computed from the Flow's owner and pinned against the supplied
  endpoints; accepting an `innerEdgeId` (or an unchecked boundary id) as input
  would reopen the hole the derivation closes.
- **The inner-Edge and FlowRoute writes must stay `createMany`/`ON CONFLICT DO
  NOTHING`** (not `create` + `P2002` catch) so the shared transaction is never
  aborted. A reviewer "simplifying" them back to `create` reintroduces the
  transaction-poisoning bug and breaks convergence.
- **Shared inner Edges are first-class.** Sweep logic that deletes an inner Edge
  while another active FlowRoute references it is a regression; restore must
  revive the shared Edge with its routes.
- **`pnpm check` cannot see into the raw boundary-derivation SQL** or the
  cross-scope writes; correctness rests on the `flow-route.service` tests against
  real Postgres (ADR-0003) — `pnpm test` is part of the Definition of Done.
- **ADR-0013 remains reserved** for Slice 4 (polarity refinement of the
  touches-endpoint invariant and the reverse-Connection reconciliation), which
  tightens this slice's direction-blind write.
