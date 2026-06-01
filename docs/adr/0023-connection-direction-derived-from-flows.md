# 23. A Connection is undirected; its arrowheads are derived from the Flows routed on it

## Status

Accepted (rollout across four slices on `feat/flow-derived-direction`).

**Superseded by [ADR-0027](0027-connection-carries-its-own-interaction.md)
(#62):** the Flow model this ADR derived direction from is retired. A Connection
now carries its own **Interaction** (an intrinsic Edge column, default
`ASSOCIATION`) and arrowheads derive from `(interaction, source, target)`, not
from routed Flows. The core insight — direction has a single un-lying source of
truth — is preserved; ADR-0027 relocates it from routed Flows to the Connection's
own `interaction`. The unordered de-dupe survives only for `ASSOCIATION`; the four
directional interactions de-dupe on the *ordered* key with `interaction` included
([ADR-0010](0010-edge-dedup-partial-unique-index.md) amendment).

**Supersedes** [ADR-0009](0009-connection-direction-is-structural.md) (a
Connection's arrow is the structural `sourceId→targetId` ordering) and
[ADR-0013](0013-polarity-not-stored-direction.md) (a Flow's polarity selects
which Connection it rides; bidirectional is two Connections; `routeFlow`
enforces a polarity-vs-arrow invariant).

**Amends** [ADR-0011](0011-flows-as-first-class-component-owned.md) (the
owner-relative `FlowPolarity` becomes the richer `FlowInteraction`),
[ADR-0012](0012-routeflow-sole-cross-scope-edge-writer.md) (the cross-scope
writer stays; its "direction-blind, Slice 4 will tighten" note is discharged —
direction is permanently derived, there is nothing to tighten),
[ADR-0005](0005-edge-scope-and-service-enforced-invariants.md) (the de-dupe key
becomes the *unordered* pair within scope), and
[ADR-0010](0010-edge-dedup-partial-unique-index.md) (the partial unique index
gains a generated-column form for the unordered pair).

## Context

A **Component** rendered exactly two **Ports** — a left "input Port" (`target`
handle) and a right "output Port" (`source` handle) — and a **Connection** could
only be drawn output→input, with `ConnectionMode.Strict` enforcing it. ADR-0009
then made the Edge's `sourceId→targetId` ordering *the* encoder of direction:
the arrow always pointed at the input Port, and a two-way relationship was **two
Connections**. ADR-0013 layered a polarity-vs-arrow invariant on top — a Flow's
`INBOUND`/`OUTBOUND` polarity had to match the Edge it rode, and a mismatch was
reconciled by offering to create a *second*, reversed Connection.

This is invalid as a model of real systems. A Component has no single input side
and output side: an API both *serves* requests and *emits* events; an
application both *calls out* and *gets called*. Forcing a direction at
wire-draw time, and forcing two Connections for a WebSocket, encodes a fiction.

The key observation: **the arrow was never a property of the Connection — it is
a property of the traffic.** ADR-0009 put direction on the column order only
because, at the time, there was nowhere else for it to live. Once **Flows**
carry direction (ADR-0011), the structural encoding became both redundant *and*
a lie-by-omission — it asserted a direction on Connections that carry no traffic
at all. Relocating the single source of truth for direction from a structural
accident of column order to the semantic objects that actually have a direction
is a model *improvement*, not a rule turned off for convenience.

## Decision

### A Connection is an unordered association; direction is derived

A Connection links two Components and stores nothing about direction. Its
rendered arrowheads are **computed**, per active routed **Flow**, from the
Flow's owner and its **interaction** verb (below): a Flow points its arrow *at*
its owner, *away* from it, or *both ways*. A Connection's arrowheads are the
union over its routed Flows — none → a plain undirected line, one direction →
one arrowhead, both → arrowheads at both ends. **A WebSocket is one Connection
with arrowheads at both ends**, not two Connections. The derivation rule lives
in one pure helper, `~/lib/flow-direction.ts`, shared by the `getCanvas`
aggregation, the optimistic canvas delta, and the markdown exporter.

### `FlowInteraction` replaces `FlowPolarity`

A Flow carries a plain-language verb describing how its owner participates,
which is the direction encoder:

- `REQUEST` — owner is called in request/response (REST, RPC) → arrow **at** owner
- `PUSH` — owner emits unprompted (SSE, webhook out, event) → arrow **away**
- `SUBSCRIBE` — owner consumes an external stream/feed → arrow **at** owner
- `DUPLEX` — owner both sends and receives (WebSocket) → arrows **both** ends

`SUBSCRIBE`/`DUPLEX` broaden the Flow concept from "a capability the owner
*exposes*" to "an interaction the owner *participates in*." The migration from
polarity is arrow-preserving: `INBOUND → REQUEST`, `OUTBOUND → PUSH`.

### `routeFlow` enforces touches-endpoint, NOT polarity

`routeFlow` keeps exactly one integrity rule: the Flow's owner must be an
endpoint of the Connection (the ADR-0012 touches-endpoint guard). The
polarity-vs-arrow rejection, the `POLARITY_MISMATCH` discriminator, and the
reverse-Connection offer are **removed**. Any owner-endpoint Flow routes onto the
single undirected Connection regardless of which way its arrow ends up pointing.
The MCP-safety concern ADR-0013 raised is answered *better*: a non-UI caller
cannot reach a wrong-polarity state because there is no such state.

### One Connection per pair (unordered de-dupe)

The de-dupe key becomes the *unordered* pair `(canvasNodeId, {endpointA,
endpointB})`, enforced service-primary with a generated-column partial unique
index as the backstop (the ADR-0010 doctrine, extended). Existing
reverse-Connection pairs (A→B and B→A produced under ADR-0013) are merged into
one Connection by a data migration that re-points their FlowRoutes and
soft-deletes the losers.

### Ports become neutral connection points

Components connect from either side with no input/output meaning; the canvas
runs `ConnectionMode.Loose`. The `flow:`-prefixed handle-id that marks a
boundary-proxy palette drag is preserved (it keys off the id, not the handle
type).

## Consequences

- **The reviewable invariant** a reviewer can check: *A Connection is an
  unordered association; its rendered direction is derived — never stored — as
  the union over its active routed Flows of (REQUEST/SUBSCRIBE ⇒ arrow at owner)
  ∪ (PUSH ⇒ arrow away) ∪ (DUPLEX ⇒ both). De-dupe is the unordered pair.
  `routeFlow` enforces touches-endpoint but NOT interaction-vs-orientation.*
  Reintroducing a stored `direction`/`polarity`-on-edge field, an ordered
  de-dupe, or an interaction-rejection in `routeFlow` regresses this ADR.
- **Net deletion.** The reverse-Connection dance, the `boundaryProxies`
  orientation split (`ownerSourceEdgeId`/`ownerTargetEdgeId`), the popover
  polarity filter, and the `POLARITY_MISMATCH` machinery all go. The
  SSE/WebSocket case the model could not express cleanly now just works.
- **A freshly drawn Connection has no arrowhead** until a Flow gives it
  direction. This is intended and more honest than the former forced arrow; the
  UI should signal "no flows yet" rather than auto-adding a direction (which
  would re-lie).
- **Rollout is four additive slices**, each leaving the app working: (1) the
  interaction verb + dropping the routing gate; (2) unordered storage + the
  merge migration; (3) the directional aggregation in `getCanvas` + boundary
  collapse; (4) Loose-mode handles + flow-derived arrowheads. The decision is
  recorded here up front; CONTEXT.md entries are rewritten by the slice that
  makes each true.
- **The four-case test matrix ADR-0013 mandated is repurposed**: all four cases
  now *succeed* and assert the derived arrow direction, instead of asserting a
  rejection.
- **#38 (markdown export of Flows) builds on this**: its connection renderer
  prints the derived direction (`A → B`, `A ↔ B`, or `A — B`), so its golden
  fixtures bake in the honest model — one re-baseline, not two.
