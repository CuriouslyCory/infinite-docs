# 9. A Connection's arrow is structural, derived from source→target; bidirectional is two Connections

## Status

**Superseded by [ADR-0023](0023-connection-direction-derived-from-flows.md).** A
Connection is now undirected: its arrowheads are *derived* from the Flows routed
on it (none → a plain line, both directions → arrowheads at both ends on ONE
Connection), and the de-dupe key is the *unordered* endpoint pair. This ADR's
core insight — that direction must have a single, un-lying source of truth — is
preserved; ADR-0023 relocates that source of truth from the Edge's column order
to the Flows that actually carry direction (which did not exist as first-class
rows when this ADR was written). The reasoning below is retained for history.

Originally: Accepted (amends ADR-0005)

## Context

A **Connection** (the user-facing link; an **Edge** in the data model — see CONTEXT.md) is drawn
between two Components and shows an arrow. Until now that arrow was a cosmetic, user-cycled
property: an `EdgeDirection` enum (`NONE` / `FORWARD` / `BIDIRECTIONAL`) stored on the Edge,
mirrored by a client-safe Zod enum, kept in lockstep by a compile-time parity guard, and
rendered via a per-direction marker map plus a "cycle direction" control on the edge. ADR-0005
already established that this `direction` is purely cosmetic and **never factors into
de-duplication** — two Connections are duplicates by `(canvasNodeId, sourceId, targetId)` alone.

Two problems followed from a user-set direction. First, the arrow could **lie**: a user could
draw `A → B` and then cycle the arrow to point the other way or nowhere, so the diagram no
longer told the truth about which way the dependency flowed. Second, it was a setting to fiddle
with at all — friction against the goal that connecting be obvious and directional by
construction.

The key observation: an Edge already stores `sourceId` (the output endpoint) → `targetId` (the
input endpoint). ADR-0005's de-dupe rule already treats `A → B` as **distinct** from `B → A`
precisely because the *ordered pair of endpoints* is the identity. So the source→target ordering
*already is* the direction — `direction` stored nothing the endpoints did not.

## Decision

**A Connection's direction is structural, not stored.** The arrow always points at the input
**Port** (the `target` handle), derived from the output→input (`sourceId`→`targetId`) ordering.
There is no `direction` to set, so it can never be wrong.

Concretely, `EdgeDirection` is removed end-to-end: the Prisma `Edge.direction` column and the
`EdgeDirection` enum, the client-safe Zod `edgeDirection` enum, the service-layer parity guard,
the `direction` field on `connectNodesInput` and `updateEdgeInput` (so `updateEdge` is now
label-only), and the client's per-direction marker map and direction-cycling control. Every
Connection renders a single arrowhead at its target; `connectNodes` and the optimistic client
both set it structurally, never from input.

**A two-way relationship is two Connections** — `A.output → B.input` and `B.output → A.input` —
replacing the old `BIDIRECTIONAL` value. Each is independently meaningful and individually
labelable. `NONE` (undirected) has no place: every Connection is inherently directed by its
endpoints.

**"Port" is the user-facing name for a React Flow handle** (input Port = `target`, output Port =
`source`), the same user-vs-code split as Component/Node and Connection/Edge (CONTEXT.md "Port").
A Connection can only run output Port → input Port; that pairing is enforced structurally by
React Flow's strict `connectionMode` (a drag can go only from a source handle to a target
handle), pinned explicitly on the canvas so the invariant cannot be silently lost. The pure
topology rules that need no database — no self-link, no duplicate against the current Connection
set — are extracted into one tested `~/lib` helper (`canConnect`) consumed by the canvas in two
places (React Flow's `isValidConnection` for instant drag feedback, and the optimistic
`onConnect` pre-flight). The helper **mirrors** a subset of the service's invariants for UX only;
`connectNodes` stays the single source of truth (ADR-0001), so it is not refactored to import the
helper — the MCP path does not pass through the client.

**Relationship to ADR-0005.** ADR-0005 established three things: Edge scope is an explicit
`canvasNodeId`, the graph invariants are enforced in the service rather than the database, and
the de-dupe key is the ordered triple `(canvasNodeId, sourceId, targetId)`. **All three remain
fully in force.** This ADR supersedes *only* ADR-0005's sub-decision that direction is a stored,
cosmetic property that "never factors into de-duplication" — there is no longer a `direction` to
factor in, and the *ordered-pair* distinctness ADR-0005 relied on is now the *sole* encoder of
flow. In particular, ADR-0005's deferral of a partial-unique-index de-dupe hardening (its
accepted TOCTOU window) is **untouched and still stands**.

**The schema change ships via `db push`, not a migration.** The repo syncs schema with
`prisma db push` (no migration history yet); dropping the column is one `db push
--accept-data-loss` (and the test harness's `global-setup` push gains the same flag). Adopting
`prisma migrate` is a separate, later concern owned by the de-dupe-hardening work, which needs
raw SQL for a partial unique index.

## Consequences

- **"The Connection arrow is structural (output→input), never a stored or user-set field" is now
  a reviewable invariant.** Re-introducing an `EdgeDirection` enum or a `direction` column is a
  regression against this ADR, not a feature. A future single-Edge "bidirectional" flag is
  rejected in advance: it would re-collide with the de-dupe key, and two Connections already
  model two-way cleanly.
- The data shape is **more MCP- and markdown-friendly, not less**: a reader infers dependency
  flow from `sourceId → targetId` alone, with no separate field to interpret (the later
  serialization milestone benefits for free).
- The change is largely a **simplification** — it deletes a column, an enum, a parity guard, a
  marker map, and a UI control while making an implicit contract explicit. Most of the requested
  behavior (two handles, fan-in/out, output→input by construction, an arrow toward the input
  Port) already held at the React Flow layer; this slice removes the cosmetic override and
  signposts the rules.
- Pre-launch there was negligible real Edge data, so dropping the column is effectively a no-op;
  any legacy `BIDIRECTIONAL` / `NONE` rows simply lose their cosmetic distinction (a
  `BIDIRECTIONAL` row becomes a single output→input Connection, its reverse undrawn).
