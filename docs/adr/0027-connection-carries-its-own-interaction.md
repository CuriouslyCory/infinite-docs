# 27. A Connection carries its own Interaction; arrowheads derive from `(interaction, source, target)`

## Status

Accepted (#62, the re-founding slice).

**Supersedes** [ADR-0023](0023-connection-direction-derived-from-flows.md)
(a Connection's arrowheads are derived from the Flows routed on it). The
single-source-of-truth-for-direction insight is preserved; #62 relocates that
source of truth from routed Flows (now deleted with the Flow model) to an
intrinsic `interaction` column on the Edge.

**Supersedes** (transitively) [ADR-0009](0009-connection-direction-is-structural.md)
(structural `source`→`target` arrow) and
[ADR-0013](0013-polarity-not-stored-direction.md) (polarity-vs-arrow gate) —
both were already superseded by ADR-0023; named here so the chain is explicit
and the retired Flow model that 0013 depended on is gone.

**Amends** [ADR-0005](0005-edge-scope-and-service-enforced-invariants.md) (the
Edge gains an `interaction` column) and
[ADR-0010](0010-edge-dedup-partial-unique-index.md) (`interaction` enters the
directional de-dupe key). The same-Canvas invariant of ADR-0005 is retired by
[ADR-0028](0028-cross-scope-connections-lineal-ingress.md).

## Context

ADR-0023 made a Connection undirected and derived its arrow from the
**Interaction** verbs of the **Flows** routed on it. #62 retires the entire
Flow model — there are no routed Flows to derive direction from.

Direction was relocated to Flows because that is where it lived (ADR-0023). With
Flows gone, direction has nowhere to live unless the Connection itself carries
it. Re-deriving from absent rows is not an option; re-introducing a _stored
arrow_ (the ADR-0009 column the project twice removed) would recreate the lie
ADR-0009/0023 fought — an arrow a user could set independently of meaning.

A WebSocket, an SSE stream, a request/response call, and a plain "these relate"
line must all be expressible as ONE Connection.

## Decision

### Interaction is an intrinsic Edge column, default `ASSOCIATION`

`Edge.interaction` is an `Interaction` enum with five values: `ASSOCIATION`
(the default), `REQUEST`, `PUSH`, `SUBSCRIBE`, `DUPLEX`. Renamed from
`FlowInteraction`; the four directional values carry over arrow-preserving. A
freshly drawn Connection is an `ASSOCIATION` — a plain undirected line — until
the user types it (the honest successor to ADR-0023's "no flows yet, no arrow").

### Draw order is preserved and load-bearing

`sourceId` / `targetId` are no longer "arbitrary" (the ADR-0023 framing): they
record which Port the drag started from and anchor the derived arrow. The
arrow is _derived_ — never stored — from `(interaction, source, target)` at
render time. This keeps the un-lying property (the arrow cannot be set
independently of meaning) while giving meaning a home.

### The canonical marker mapping

One pure helper (the successor to `~/lib/flow-direction`) is the single source
of truth for `(interaction, source, target) → { markerStart, markerEnd }`,
shared by the canvas renderer (#65) and the exporter (#67):

- `REQUEST` / `PUSH` → arrow at **target**;
- `SUBSCRIBE` → arrow at **source**;
- `DUPLEX` → arrows at **both** ends;
- `ASSOCIATION` → **neither** (a plain line).

This mapping matches the rendering spec in #65, which is its first consumer.

### `ASSOCIATION` is the untyped default and de-dupes unordered

A plain undirected relationship; the value a freshly drawn Connection gets when
the user expresses no direction. It alone uses the unordered de-dupe pair
(ADR-0010 amendment); the four directional values use the ordered key with
`interaction` included.

### Rendering is deferred to #65; #62 lands the column + semantics only

Every Connection renders as a plain line in #62; the marker map is wired into
the canvas in #65 and the exporter in #67. The semantics are recorded now so
those slices have a spec.

## Consequences

- **Reviewable invariant:** _A Connection's rendered direction is derived —
  never stored — from `(interaction, source, target)`. `interaction` is a type
  with one undirected value (`ASSOCIATION`); re-introducing a stored
  `direction`/`polarity` column, or deriving the arrow from anything other than
  the canonical helper, regresses this ADR._
- `interaction` enters the directional de-dupe key (ADR-0010 amendment):
  `A→B REQUEST` and `A→B PUSH` coexist as distinct Connections; `label` stays
  out of every key.
- #65 (arrowhead rendering) and #67 (export prints the interaction glyph)
  consume the canonical helper; one place owns the mapping.
- The ADR-0023 four-case arrow test matrix is repurposed: cases now assert the
  arrow derived from the Connection's own `interaction`, not from a routed Flow.

## Realized in #65

The deferred rendering landed in #65: the canonical helper is
`~/lib/connection-direction.ts` (`arrowEnds(interaction) → { atSource, atTarget }`),
a pure module importing only the client-safe `Interaction` type. The canvas maps
its booleans to React Flow `markerStart`/`markerEnd` in `toRFEdge` (the marker
mapping lives in the island, never in `~/lib`, so `@xyflow/react` does not leak —
ADR-0004); the exporter (#67) derives the `→`/`←`/`↔`/`—` glyph from the same
booleans. The four-case matrix is asserted in `connection-direction.test.ts`.

### Amendment — interaction is editable after creation

#65 added a picker on the selected Connection that upgrades its `interaction`
(e.g. `ASSOCIATION` → `REQUEST`). This is a distinct write surface from label
editing because, unlike `label` (in no de-dupe key), `interaction` is in the
directional de-dupe key — so an edit can collide:

- The edit goes through `updateEdgeInteraction` (its own input/service/procedure),
  not `updateEdge` (which stays label-only and never collides).
- `sourceId`/`targetId` are **never rewritten**, so the upgraded arrow points the
  way the Connection was drawn.
- The service re-evaluates the de-dupe slot for the new interaction (reusing
  `activeDuplicateWhere`, with the edge's own `id` excluded — a row is not its own
  duplicate) and returns a `ConflictError` if another active Connection already
  holds the target slot; the partial unique index is the TOCTOU backstop, the same
  shape `connectNodes` uses.

**Reviewable invariant:** changing a Connection's interaction re-keys its de-dupe
slot; an upgrade that would duplicate an active Connection is rejected, and draw
order is preserved through the change.
