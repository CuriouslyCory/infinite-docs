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

Amended by [ADR-0023](0023-connection-direction-derived-from-flows.md): this
ADR's "direction-blind inner-Edge write, Slice 4 will tighten" note is
**discharged** — direction is permanently DERIVED from a Flow's interaction at
read time, so there is nothing to tighten and `routeFlow` enforces only
touches-endpoint. The `boundaryProxies` orientation split (which ADR-0013 added
and this ADR's lexically-first min-id anticipated) collapses back to a single
incident `outerEdgeId`: a Connection is undirected, so one Edge per pair carries
any Flow. The cross-scope-writer, find-or-create convergence, and `FOR UPDATE`
sweep-race lock are all untouched.

## Context

Slice 3 is the refinement slice: descend into a Component, see the externals it
connects to as read-only **boundary proxies**, and drag one of a proxy's
**Flows** onto a child Component to say _"this Flow, one scope deeper, continues
as this interior Connection."_ That binding is a **FlowRoute** whose
`innerEdgeId` finally points at a real **Edge** — the **inner Edge** between the
child and the boundary proxy.

That inner Edge is the one place the system must write an Edge whose endpoints
sit at **different scope levels**: the child lives on the current Canvas
(`parentId === canvasNodeId`), but the boundary proxy is the real external
Component, which lives higher up (`parentId !== canvasNodeId`). ADR-0005 made
Edge scope an _explicit, recorded_ `canvasNodeId` precisely so this could exist
with no schema change — and said in as many words that "only the validation rule
will loosen." This ADR records that loosening and the four judgment calls it
forced, none derivable from ADR-0005 alone:

1. **Who may write a cross-scope Edge, and how is the loosening bounded** so it
   does not become a hole in the same-Canvas invariant?
2. **How is the inner-Edge write made race-safe** under `idx_edge_dedup`, given
   that two refinements of the same outer Edge legitimately _share_ one inner
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
endpoint is the **boundary endpoint** — and the boundary endpoint is _derived,
never taken from input_. `routeFlow` accepts `{ flowId, outerEdgeId,
sourceNodeId?, targetNodeId? }`; it computes the boundary endpoint `B` as the
Flow's owner (already required, by the touches-endpoint invariant, to be an
endpoint of the outer Edge) and requires that exactly one of the supplied
endpoints equals `B`. The other is the **interior endpoint**, which must be a
child of the outer Edge's _other_ endpoint (the Canvas the inner Edge sits on).
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
_outside_ a transaction. The `createMany` form lets the inner Edge and the
FlowRoute commit **atomically in one transaction with no retry loop**. This names
`routeFlow` as the **second writer that closes the `idx_edge_dedup` race**
(ADR-0010 anticipated a second adopter); convergence here is correctness-defining,
not cosmetic. The FlowRoute write uses the same `createMany` form — a `count === 0`
result is the concurrent-duplicate signal that re-reads for the readable
`ConflictError { conflictingFlowRouteIds }`, with the pre-check `findFirst`
serving the common sequential case.

### A shared inner Edge is swept only when no other active FlowRoute references it

Because inner Edges are shared, the cascade is **reference-counted**, not
one-to-one. `unrouteFlow` sweeps a FlowRoute's inner Edge **only when no _other_
active FlowRoute references it** (the count excludes the row being deleted); when
it does sweep, it mints one `deletionId` and stamps both rows so `restoreEdge`
revives them as a unit, otherwise it is a lone soft-delete with no `deletionId`
(ADR-0008's lone-delete rule). `deleteEdge`'s cascade (ADR-0014) gains the same
rule: sweeping an outer Edge sweeps its FlowRoutes, and each inner Edge they
carried **only when no surviving active FlowRoute still references it**.
`restoreEdge` revives by `deletionId` and so brings the inner Edge back with its
routes. **"A shared inner Edge survives as long as one active FlowRoute rides it"
is a reviewable invariant**, pinned by tests.

The reference-count read and the conditional sweep are **read-then-write**, so
under Postgres' default READ COMMITTED isolation two concurrent sweeps of the
last routes on one inner Edge could each see the _other_ still active and both
skip the sweep — orphaning an active inner Edge with zero active routes. **The
last-referer decision is serialized per inner Edge by a `SELECT … FOR UPDATE` row
lock in the caller's transaction**, taken before the count. All three cross-scope
writers take that same lock on the inner-Edge row: `unrouteFlow` and `deleteEdge`
before counting referers, and `routeFlow` after find-or-creating the inner Edge
and before writing the FlowRoute that references it (re-checking liveness after
the lock and re-resolving to a fresh Edge if it was swept in the read-then-lock
window). Locking the **same** row in all three — and, in `deleteEdge`, locking a
candidate set in one `ORDER BY id … FOR UPDATE` statement — gives a consistent
acquisition order, so no pair can cycle-deadlock. **"Every cross-scope writer
locks the inner-Edge row before deciding whether it survives" is a reviewable
invariant**, pinned by concurrent-race tests.

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
- **Every cross-scope writer must lock the inner-Edge row (`FOR UPDATE`) before
  deciding its fate.** Dropping the lock from `routeFlow`, `unrouteFlow`, or
  `deleteEdge` reopens the READ COMMITTED sweep race (a live route orphaned on a
  swept inner Edge, or a swept Edge with a surviving route). `pnpm check` cannot
  see this; the concurrent-race tests are the backstop.
- **A refinement route leaves the parent Connection's routed-count pill stale
  until the user ascends.** The route is written one scope below the outer Edge,
  so the client refreshes the _interior_ Edge (optimistically) and the parent's
  unrouted-filter cache (`getRoutedFlowIdsForEdge`), but **not** the parent
  scope's `getCanvas` — the pill is a `routed/total` count that re-reads on the
  next ascend (a fresh `getCanvas`). This is a deliberate Philosophy-#1 choice:
  invalidating the parent scope on every refinement would cost a cross-scope
  round-trip per route. The window is "descend → route → ascend shows the new
  count"; a user who never ascends never sees the stale pill.
- **`pnpm check` cannot see into the raw boundary-derivation SQL** or the
  cross-scope writes; correctness rests on the `flow-route.service` tests against
  real Postgres (ADR-0003) — `pnpm test` is part of the Definition of Done.
- **ADR-0013 (Slice 4) discharges this slice's direction-blind write.**
  [ADR-0013](0013-polarity-not-stored-direction.md) adds the polarity refinement
  of the touches-endpoint invariant (`INBOUND ⇒ owner = target`, `OUTBOUND ⇒
owner = source`) and the reverse-Connection reconciliation, and replaces this
  slice's single `outerEdgeId` proxy field with the orientation-split
  `ownerSourceEdgeId` / `ownerTargetEdgeId` pair (see the boundary-derivation
  note above — "polarity picks the right one in Slice 4" is now realized).
- **Polarity is enforced at the UI layer, not in the service — a precondition on
  MCP exposure.** A boundary proxy's palette renders each Flow's refinement Port
  with the polarity-correct handle type (`target` for INBOUND, `source` for
  OUTBOUND), so a human drag cannot synthesise a wrong-polarity inner Edge; the
  service is deliberately direction-blind. When `routeFlow` is exposed to a
  non-UI caller (the MCP `route-flow` resource, deferred to #42), that handle-
  level guard is gone — the polarity check must move into the service (the
  ADR-0013 work) **before** that exposure lands, or an agent with the input
  schema can write a wrong-polarity inner Edge. _(Satisfied by
  [ADR-0013](0013-polarity-not-stored-direction.md): the polarity invariant now
  lives in `routeFlow`, so #42 inherits it.)_

## Reviewer checklist (cross-scope writer)

"`routeFlow` is the sole cross-scope Edge writer" cannot be machine-checked —
`pnpm check` cannot reason about whether an `Edge` write is cross-scope, and a
source-grep guard would false-positive on every legitimate same-Canvas write
(`connectNodes`, `createNode`'s seeding, `restoreEdge`). It is enforced by review.
When a change touches Edge writes, confirm:

1. **The only `db.edge.create`/`createMany` whose `canvasNodeId` may differ from
   both endpoints' `parentId` is `resolveInnerEdgeId`.** Any new Edge write
   elsewhere must satisfy ADR-0005's same-Canvas rule (both endpoints'
   `parentId === canvasNodeId`). The `connectNodes still rejects a cross-scope
endpoint` test pins `connectNodes`.
2. **`resolveInnerEdgeId` still derives the boundary endpoint from the Flow's
   owner** and pins it against a supplied endpoint — no `innerEdgeId` (or raw
   boundary id) is accepted as input.
3. **All three cross-scope writers still take the inner-Edge `FOR UPDATE`** before
   deciding the Edge's fate (the sweep-race guard above).
4. **Boundary derivation stays a read** — `deriveBoundaryProxies` persists no
   rows and keeps its "caller must have authorized `projectId`" contract; it is
   not reused from an unauthorized path.

A new cross-scope Edge writer, or a violation of any of the above, regresses
ADR-0005 and this ADR.
