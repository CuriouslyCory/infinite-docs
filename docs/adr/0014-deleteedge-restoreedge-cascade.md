# 14. `deleteEdge`/`restoreEdge` cascade and the conditional `deletionId`

## Status

Accepted (Slice 2 of flow-routed-connections). Extends
[ADR-0008](0008-cascading-soft-delete-stamped-batch.md) (the stamped-batch
soft-delete + undo mechanism) and [ADR-0011](0011-flows-as-first-class-component-owned.md)
(Flows as first-class, including the orphan-visibility invariant). ADR-0008's
Status block points here.

## Context

Slice 2 introduces the **FlowRoute** — the first-class row that binds a **Flow**
to a **Connection** at a Canvas scope (CONTEXT.md "FlowRoute"). Once a Connection
can _carry_ Flows, deleting that Connection has to do something with the wiring
that rode it, and undo has to put the wiring back. ADR-0008 already established
the stamped-batch machinery for the **Component** cascade (`deleteNode` /
`restoreNode`): one `deletionId` per operation, stamped on every swept row,
cleared as a unit on restore. This ADR records how that machinery extends to the
**Edge** cascade — and the three judgment calls that extension forced, which are
not derivable from ADR-0008 alone:

1. **When does `deleteEdge` mint a `deletionId`?** A lone `deleteEdge` historically
   minted none (ADR-0008's "lone delete" carve-out, so an undo of a later batch
   can never revive an independently-removed Edge). FlowRoutes break the symmetry:
   a `deleteEdge` that sweeps routes _is_ now a batch.
2. **What is the restore inverse, and is it complete?** ADR-0008 only had
   `restoreNode`. An Edge swept outside a Component delete needs its own undo.
3. **How do the forward-compat cascade arms (`innerEdgeId`, `flowId`) and the
   restore pre-checks fit** — given that Slice 2's invariants make some of them
   unreachable today?

## Decision

### `deleteEdge` mints a `deletionId` **iff** it sweeps ≥1 incident FlowRoute

`deleteEdge` gathers the live FlowRoutes incident to the Edge (by `outerEdgeId`
**or** `innerEdgeId` — see below). If there are **none**, ADR-0008's lone-delete
rule stands unchanged: the Edge soft-deletes with **no** `deletionId`, and no
later undo can revive it. This is the dominant path and is unchanged from Slice 1.

If there **is** at least one incident route, the delete becomes a batch: it mints
one fresh `deletionId` and stamps it on **both** the Edge and the swept FlowRoutes,
exactly as `deleteNode` stamps its subtree. A cascade is therefore no longer
"lone" in ADR-0008's sense once routes are swept — that is the precise wording
ADR-0008's consequences carry, now scoped to the no-FlowRoute path.

### `restoreEdge` is the inverse; `restoreNode` gains an additive FlowRoute arm

`restoreEdge(deletionId)` clears `deletedAt` **and** `deletionId` for **exactly**
the rows bearing that id — the Edge and its swept FlowRoutes — mirroring
`restoreNode`'s shape. A lone-`deleteEdge` id (there is none) or an unknown id
matches no rows and reads as not-found. `deleteNode`'s cascade gains an **additive
FlowRoute sweep** alongside its Node / Edge / Flow / FlowSpec arms, and
`restoreNode` gains a matching `idx_flow_route_dedup` pre-check, so a Component
delete that subsumes routed Connections still restores as one unit.

### Atomicity is a **caller-supplied transaction**, enforced by contract

`deleteEdge`'s cascade is two writes (stamp the Edge, sweep the FlowRoutes);
`restoreEdge`/`restoreNode` are likewise multi-write. These must commit atomically,
but the services take a bare `Db` and **rely on the caller to wrap them in
`db.$transaction`** — the tRPC procedures do (`deleteEdge`, `restoreEdge`,
`restoreNode` are all `$transaction`-wrapped), matching ADR-0008's `deleteNode`
precedent. Prisma exposes no reliable "am I already in a transaction?" probe, so
this is **enforced by contract and a pointed code comment at the write pair**, not
by a runtime assertion. This is a genuine fragility: `deleteEdge` is the first
member of this family whose multi-write is _conditional_ (only routed edges
cascade), so a non-transactional caller compiles, works for every routeless edge,
and only leaves a half-swept cascade for a routed edge under a mid-operation
failure. The contract is the accepted mitigation; row-level hardening rides along
with ADR-0008's deferred M4 concurrency work.

### Restoring a route onto a Flow that died in the interim yields an **orphan, by design**

`deleteEdge` stamps the Edge and its routes — it does **not** touch the routes'
Flows (an Edge delete has no business deleting a Flow). So between a `deleteEdge`
and its `restoreEdge`, the route's Flow may be independently soft-deleted (a
re-parse dropping its key, or a `deleteFlow`). `restoreEdge` **still revives the
route** — it does not skip routes whose Flow has since died, and it does not hard-
fail. The revived route then points at a dead Flow and is counted under
`getCanvas.edgeFlows.orphan`, so the wiring **hangs visibly rather than vanishing
or blocking the undo**. This is a deliberate extension of ADR-0011's orphan-
visibility invariant to the restore path (pinned by a `flow-route.service` test),
not an emergent accident.

### The `innerEdgeId` / `flowId` cascade arms are deliberate forward-compat

The `deleteEdge` sweep matches routes by `outerEdgeId` **or** `innerEdgeId`, and
the `deleteNode` sweep additionally matches by `flowId`. Under **Slice 2's**
touches-endpoint invariant (`routeFlow` requires `flow.ownerNodeId ∈ {edge.source,
edge.target}`, and `innerEdgeId` is always null), these extra arms are **provably
redundant** with the `outerEdgeId` / `edgeId` arm: a route's `outerEdge` always
touches its Flow's owner, so if the owner is swept the edge is already in the swept
set; and `innerEdgeId` is never written. They are kept anyway because **cascade
completeness is a correctness property that cannot be retrofitted safely** — a
delete that occurs between Slice 2 and Slice 3 (which introduces the gated cross-
scope `innerEdgeId` writer, ADR-0012) would leak a route the later arm was meant to
catch. This is an **accepted, named exception** to the "prefer narrow required
inputs" default: the _input_ schema (`routeFlowInput`) stays narrow with no
`innerEdgeId` field, while the _cascade_ builds the arm ahead of its writer. The
restore-side `idx_flow_route_dedup` pre-check in `restoreEdge`/`restoreNode` is
similarly **defensive**: single-threaded under Slice 2 it cannot be triggered
(you can't route onto a soft-deleted edge to occupy the slot), so it is a
TOCTOU/forward-compat backstop, with the actual concurrent race caught by the
`isFlowRouteDedupCollision` catch path. Both are documented as defensive rather
than covered by contrived tests (Philosophy #6: understand the rule, don't game
the check).

## Consequences

- **"`deleteEdge` mints a `deletionId` iff it sweeps ≥1 incident FlowRoute" is a
  reviewable invariant.** Minting unconditionally would let an undo revive an
  Edge removed by an independent lone `deleteEdge`, regressing ADR-0008's carve-out.
- **"`restoreEdge` revives a route even when its Flow has since died, surfacing it
  as an orphan" is a reviewable invariant** — a future change that makes restore
  skip such routes or hard-fail regresses the orphan-visibility philosophy
  (ADR-0011) this ADR extends.
- **The caller-supplied-transaction contract is convention-only.** A reviewer must
  ensure any new caller of `deleteEdge`/`restoreEdge`/`restoreNode` wraps it in
  `db.$transaction`; the type system will not catch a violation.
- **The `innerEdgeId` / `flowId` cascade arms and the FlowRoute restore pre-check
  are intentionally dead/redundant under Slice 2.** They are forward-compat for
  Slice 3 cross-scope routing; a reviewer must not "simplify" them away as unused.
  **Discharged in Slice 3:** [ADR-0012](0012-routeflow-sole-cross-scope-edge-writer.md)'s
  gated cross-scope writer now populates `innerEdgeId`, so the `deleteEdge` sweep
  reaches real inner Edges — and was extended there with the reference-counted
  rule (a shared inner Edge is swept only when no other active FlowRoute rides it).
  That survivor count is **read-then-write**: `deleteEdge` therefore locks the
  candidate inner-Edge rows with a single `ORDER BY id … FOR UPDATE` before
  counting, closing the READ COMMITTED window against a concurrent
  `routeFlow`/`unrouteFlow` (which take the same per-row lock). See ADR-0012's
  reference-counted-sweep section for the shared discipline.
- **`pnpm check` cannot see into the raw aggregation SQL** that reads these routes
  (`getCanvas.edgeFlows`); correctness rests on the `flow-route.service` tests
  against real Postgres (ADR-0003). `pnpm test` is part of the Definition of Done.
- **ADR numbers 0012 and 0013 remain reserved** for Slice 3 (the gated cross-scope
  `innerEdgeId` writer) and Slice 4 (polarity refinement of the touches-endpoint
  invariant) respectively — both already referenced by committed code — so this
  Slice-2 cascade decision takes **0014** even though it predates them.
