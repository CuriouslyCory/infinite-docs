# 13. A Flow's polarity selects which Connection it rides; bidirectional is still two Connections

## Status

Accepted (Slice 4 of flow-routed-connections). Reaffirms
[ADR-0009](0009-connection-direction-is-structural.md) (a Connection's direction
is structural — the arrow cannot lie) and tightens the deliberately
direction-blind inner-Edge write of
[ADR-0012](0012-routeflow-sole-cross-scope-edge-writer.md); builds on
[ADR-0011](0011-flows-as-first-class-component-owned.md) (Flows as first-class,
the owner-relative `FlowPolarity`) and
[ADR-0005](0005-edge-scope-and-service-enforced-invariants.md) (invariants
enforced in the service). Discharges ADR-0012's reserved-ADR-0013 note and the
MCP-exposure precondition it set.

## Context

[ADR-0009](0009-connection-direction-is-structural.md) removed stored direction:
an **Edge**'s single arrow is derived from its `sourceId → targetId` ordering and
nothing else, so it cannot drift or lie. [ADR-0011](0011-flows-as-first-class-component-owned.md)
added **polarity** — a Flow's owner-relative direction, `INBOUND` (the owner
consumes) or `OUTBOUND` (the owner emits) — but deferred the consistency check
between a Flow's polarity and the arrow of the Connection it is routed onto.
[ADR-0012](0012-routeflow-sole-cross-scope-edge-writer.md) then wrote the inner
Edge **direction-blind**: it bound a Flow to whatever outer Edge it was handed,
checking only that the Flow's owner was *an* endpoint (the touches-endpoint
invariant), never that it was the *correct* endpoint for the Flow's polarity.

That leaves one gap, and it is the whole of the SSE/WebSocket case. Consider an
API Component exposing an `OUTBOUND` SSE Flow, with only a `Web Server → API`
Connection drawn. Routing the SSE Flow onto that Connection would render its
arrow pointing **at** the API — backwards for a Flow the API *emits*. There are
only two ways to resolve this:

1. **Re-introduce a per-Flow direction override** so the same Connection can
   render an Flow's arrow either way — which directly recreates the lying
   `direction` field ADR-0009 deleted.
2. **Treat polarity as the encoder** and require a *second* Connection
   (`API → Web Server`) for traffic that flows the other way — two Connections,
   each carrying the polarity-matched Flows that point its way.

A second pressure forces the timing. ADR-0012 made the polarity guard a property
of the **UI** — a boundary proxy renders each Flow's refinement Port with the
polarity-correct handle type, so a human drag cannot synthesise a wrong-polarity
inner Edge. But that guard vanishes for a non-UI caller. ADR-0012 named this a
precondition on exposing `routeFlow` to MCP (#42): the check **must** move into
the service before that exposure lands.

## Decision

### Polarity is the encoder; the service enforces the invariant

`routeFlow` enforces, for every route (same-Canvas baseline and cross-scope
refinement alike), that the Flow's owner occupies the polarity-correct end of the
outer Edge:

- `INBOUND` ⇒ `flow.ownerNodeId === edge.targetId` (the owner consumes, so the
  arrow points **at** it);
- `OUTBOUND` ⇒ `flow.ownerNodeId === edge.sourceId` (the owner emits, so the
  arrow points **away**).

This tightens ADR-0012's touches-endpoint guard from "owner is *an* endpoint" to
"owner is the *correct* endpoint." The weaker check stays as the precondition
before it: "owner isn't on this Edge at all" is a distinct, non-discriminable
error from "owner is on the wrong end." The check sits before
`resolveInnerEdgeId`, so a mismatched route never find-or-creates an inner Edge.
**"Polarity is enforced in the service, not just the UI" is a reviewable
invariant** — removing it reopens the MCP hole ADR-0012 flagged.

### The rejection is a discriminable `ValidationError`, not a new error code

A polarity mismatch is a well-formed-but-meaningless request — exactly
`ValidationError` (`code: "BAD_REQUEST"`). It is **not** a new
`ArchitectureErrorCode`: that union is a small, transport-shaped set, and adding
`POLARITY_MISMATCH` to it would force a new arm in every transport adapter
(tRPC's `toTRPCError`, the future MCP mapping) for a value that maps to
`BAD_REQUEST` anyway. Instead, following the `ConflictErrorDetails` precedent,
`ValidationError` carries an optional typed `details`:
`{ reason: "POLARITY_MISMATCH", expectedOwnerRole: "source" | "target" }`. The
tRPC `errorFormatter` already flows `cause.details` to `error.data.archDetails`
generically — no per-code mapping — so the discriminator reaches the web client
and the MCP `cause.details` for free. `expectedOwnerRole` is the AI-readable fact
a non-UI caller needs to draw the reverse Connection without re-deriving the
rule.

### A mismatch is reconciled by a second Connection, never a reversed arrow

Reaffirming ADR-0009: bidirectional traffic is **two Connections**, not a second
arrowhead and not a `BIDIRECTIONAL` polarity. The canvas detects the mismatch
**before** dispatching `routeFlow` — it reads the boundary proxy's
orientation-split outer-Edge ids (below) and, when the polarity-matching
orientation is absent, does not dispatch. It offers a one-click "Add the
reverse Connection to carry this?" On confirm, one batched optimistic gesture:
`connectNodes` creates the reverse outer Edge, then `routeFlow` creates the inner
Edge + FlowRoute against it. The service polarity check is the **backstop** for
non-UI callers; the UI pre-detection is the delightful path.

### Boundary-proxy orientation is split so the canvas can decide before dispatch

The reverse-Connection offer requires the canvas to know, *before* dispatching,
whether a polarity-matching outer Edge exists — but the outer Edge lives one
scope up, outside the current `getCanvas` payload. ADR-0012's `boundaryProxies`
carried a single lexically-first `outerEdgeId`, which collapses the
two-directions case (`A→B` and `B→A`) to one id and loses orientation. Slice 4
replaces it with a **directional pair**: `ownerSourceEdgeId` (the owner is the
Edge's source — carries OUTBOUND Flows) and `ownerTargetEdgeId` (the owner is the
target — carries INBOUND Flows), each nullable. The recursive boundary CTE
computes both with two conditional `MIN`s over the same depth-0 join, so it stays
one round trip (ADR-0001 preserved). A null on the polarity-matching side *is* the
mismatch that triggers the offer.

### The reverse offer is a client-sequenced batch, not a new mutation surface

The reverse offer reuses the existing `connectNodes` + `routeFlow` writers,
sequenced client-side — **no new service mutation**. The reverse outer Edge is a
**strict same-Canvas write** at the *parent* scope (both endpoints sit on the
parent Canvas because the proxy is direct), so `connectNodes` stays strict and
ADR-0012's "sole cross-scope writer" invariant is untouched. The two calls are
**not** wrapped in one server transaction; the client owns the all-or-nothing
*optimistic* rollback (both the temp inner Edge and the gesture roll back with one
toast on any failure). The deliberate alternatives — a third atomic
`connectAndRoute` service function, or a client-driven compensating `deleteEdge`
— are rejected: the former would either loosen `connectNodes` or duplicate
`routeFlow`'s whole invariant chain (regressing ADR-0012), and the latter is a
network call that can itself fail. See the partial-failure consequence below.

## Consequences

- **"An INBOUND Flow rides an Edge whose target is its owner; an OUTBOUND Flow an
  Edge whose source is its owner — enforced in `routeFlow`" is a reviewable
  invariant.** Reverting it to a UI-only guard reopens the MCP hole ADR-0012
  named; #42 inherits this check for free *because* it lives in the service.
- **Polarity mismatch is a `ValidationError` with `details.reason =
  "POLARITY_MISMATCH"`, not a new `ArchitectureErrorCode`.** A reviewer
  "promoting" the discriminator into the code union breaks the transport-shaped
  contract of that enum and forces needless adapter arms.
- **Bidirectional traffic stays two Connections (ADR-0009 reaffirmed).** Any
  re-introduction of a per-Flow direction override or a one-Edge-two-arrowheads
  rendering regresses ADR-0009 and this ADR.
- **`boundaryProxies` entries now carry `ownerSourceEdgeId` / `ownerTargetEdgeId`
  instead of a single `outerEdgeId`.** This retires ADR-0012's lexically-first
  min-id (and its "polarity picks the right one in Slice 4" note). Consumers pick
  the orientation matching a Flow's polarity.
- **The reverse-offer confirm is two sequential mutations, so a
  `connectNodes`-succeeds / `routeFlow`-fails interleaving leaves a live,
  routeless reverse Connection.** This is a *valid graph state* — the same shape
  as a freshly drawn Connection with nothing routed yet — recoverable with one
  `deleteEdge`. It is accepted over a new atomic mutation surface (ADR-0012 keeps
  `connectNodes` strict and `routeFlow` the sole cross-scope writer) and over
  client compensation (which can itself fail). The optimistic rollback always
  fires, so the user never sees a partial result; the orphaned Connection
  surfaces on the next parent `getCanvas`. Retrying the gesture after a
  `routeFlow` failure does not duplicate the reverse Connection: `connectNodes`
  de-dupes on `(canvasNodeId, sourceId, targetId)` (ADR-0005/0010), so the
  retry converges on the same Edge and only `routeFlow` re-runs. On `connectNodes`
  success the canvas writes the new Edge id onto the proxy's matching orientation
  in the `getCanvas` cache, so an immediate same-polarity re-drag routes directly
  rather than re-offering and colliding on the now-existing Connection.
- **The same-Canvas "+ flow" popover hides polarity-mismatched Flows.** Because
  the service now rejects them, the popover filters each endpoint's offered Flows
  by polarity (a source endpoint offers only OUTBOUND, a target endpoint only
  INBOUND) rather than surfacing a pick the service would reject. A same-Canvas
  reverse offer from the popover is deferred (the Scene-5 reverse offer is the
  cross-scope palette-drag path). This popover tightening closes the *actionable*
  path to a wrong-polarity route now; the only residue of the read/write
  asymmetry below is the passive `edgeFlows.total` pill, which is display-only and
  self-heals on the next `getCanvas`.
- **`pnpm check` cannot see the polarity invariant or the directional-pair SQL.**
  Correctness rests on the `flow-route.service` tests against real Postgres
  (ADR-0003) — the four-case matrix (INBOUND/OUTBOUND × forward/reverse Edge) and
  the end-to-end SSE reverse scenario. `pnpm test` is part of the Definition of
  Done.

## Reviewer checklist (polarity invariant)

When a change touches `routeFlow`, the boundary derivation, or the palette-drag
gesture, confirm:

1. **`routeFlow` still selects `flow.polarity`** and enforces `INBOUND ⇒ owner =
   target` / `OUTBOUND ⇒ owner = source` before resolving the inner Edge. A
   dropped `polarity: true` in the select makes the check read `undefined` and
   silently pass — the four-case test matrix pins it.
2. **The rejection stays a `ValidationError` with `details.reason =
   "POLARITY_MISMATCH"`** — not a new `ArchitectureErrorCode`, not a silent write.
3. **`boundaryProxies` exposes both orientations** (`ownerSourceEdgeId` /
   `ownerTargetEdgeId`); the canvas picks by polarity and offers the reverse
   Connection when the matching side is null.
4. **The reverse offer reuses `connectNodes` + `routeFlow`** with the reverse
   Edge written at the parent scope (a strict same-Canvas write) — no new atomic
   mutation, and `connectNodes` is not loosened.

A violation of any of the above regresses ADR-0009 or this ADR.
