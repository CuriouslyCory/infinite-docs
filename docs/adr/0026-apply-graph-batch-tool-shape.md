# 26. apply_graph as transactional batch substrate with client-id reference resolution

## Status

Accepted (#20, MCP `apply_graph` batch tool).

**Relates to** [ADR-0001](0001-service-layer-db-actor-input.md) (the
`(db, actor, input)` service contract; composition over reimplementation),
[ADR-0010](0010-edge-dedup-partial-unique-index.md) (the additive
`ConflictError.details` envelope — this slice is the fourth adopter),
[ADR-0022](0022-authenticated-mcp-read-surface.md) (the owner-gated
token-Actor posture and the not-found-equals-forbidden non-disclosure rule the
batch inherits at the MCP edge), and
[ADR-0024](0024-movenode-reparent-reject-orphaning.md) (the
`(action, structured detail)` self-correction shape any future update-arm of
this tool must honour per row).

## Context

Issue #19 shipped four single-op MCP write tools — `create_component`,
`connect_components`, `update_component_docs`, `move_component` — each a thin
adapter over an existing service, wrapped in `db.$transaction` per call. The
shape is correct: every tool reuses the `(db, actor, input)` service contract
(ADR-0001) and every authz check derives from the resolved Actor's `userId`
(ADR-0022). What the shape is **not** is cheap when an agent constructs an
architecture from a description. A 20-Component / 40-Connection draft is 60
round trips with serial dependencies: every Connection waits for both
endpoint Components' server ids to come back before the agent can reference
them. The agent ends up doing read-after-write to chain ids — exactly the
waterfall philosophy #1 forbids.

Issue #20 introduces the batch substrate: one MCP tool, one transaction, one
response carrying a `clientId → serverId` map the agent generates **inline**
so it can chain references without any intermediate reads. The whole batch
succeeds atomically or rolls back; partial writes never persist.

Two owner comments on #20 are binding and shaped this ADR:

1. **Discriminated top-level arrays** (`components: []`, `connections: []`),
   not a flat `entities: []` with a per-row discriminator. The owner argued
   the typed-arms shape reads cleanly when Slice 5 (#38) appends `flows: []`
   and `routes: []` — and the flat shape would have re-discriminated on every
   read.
2. **The reference map is keyed by `clientId` alone**, not
   `(kind, clientId)`. The owner argued a tuple key invites the agent to
   reuse `"n1"` across two arms and then forces the lookup site to remember
   which one — every future arm collides into the same flat namespace
   instead.

Both comments are upstream of the schema; both are codified below.

## Decision

### 1. Discriminated top-level arrays, not a flat `entities: []`

`applyGraphInput` is shaped as
`{ projectId, components: ApplyGraphComponentInput[], connections: ApplyGraphConnectionInput[] }`.
Slice 5 / #38 appends `flows: []` and `routes: []` here without renumbering,
because each arm is its own typed array — the schema, the Zod parse, and the
service all dispatch on field name, not on a per-row tag. A flat
`entities: []` with a `type: "component" | "connection"` discriminator was
considered and rejected: it would have forced every reader (the topological
sort, the reference resolver, the error enricher) to re-discriminate the
union on every loop, and the per-arm cardinality caps (`max(500)` Components,
`max(1000)` Connections) would have had to live somewhere weirder than the
schema. The owner's "typed arms" comment matches the in-codebase precedent
ADR-0017's deterministic markdown emitter uses for its own per-kind sections,
and the registry-of-arms shape ADR-0025 settled on for the parsers' shared
`Record<FlowSpecKind, SpecParser | null>`.

### 2. The `idMap` is keyed by `clientId` alone

The response is `{ idMap: Record<string, string>, componentCount, connectionCount }`.
Cross-arm uniqueness is enforced in Zod's `superRefine` so a `"n1"` in
`components[]` cannot collide with a `"n1"` Slice 5 might introduce in
`flows[]` — the namespace is flat by construction, not by accident. The
alternative (a `(kind, clientId)` tuple, or nested `idMap.components[…]`)
was rejected on the owner's read: an agent picks one `"n1"` per request and
expects to call back with one server id; layering a kind on the lookup
quietly admits two `"n1"`s where each refers to a different row, and forces
the agent to remember which kind it was looking up. The cap (`clientId.max(64)`)
keeps the map bounded and the wire format predictable.

### 3. Polymorphism via discriminated `NodeRef`, not a sigil prefix and not heuristic resolution

A Component's `parent` and a Connection's `source` / `target` / `canvasNode`
accept either a server-minted id or a sibling clientId. Three encodings were
weighed:

- **Sigil prefix** (`"@n1"` is a client ref, anything else is a server id).
  Rejected: loses static type narrowing — the wire format becomes a tagged
  string the agent and the service must each decode by string-inspection,
  and a future change to the prefix is a wire break. Bakes the encoding into
  the data.
- **Heuristic** (treat any string that appears as a clientId elsewhere in the
  batch as a client ref; anything else as a server ref). Rejected: a silent
  rebinding landmine the moment a real server id happens to equal a clientId
  the agent picked — and Postgres cuids are 24+ chars of `[a-z0-9]`, well
  inside the 64-char clientId budget. The collision space is small but real,
  and the failure mode is "writes the wrong row," which is the worst kind of
  silent.
- **Tagged discriminated union**
  (`{ref: "server", id} | {ref: "client", clientId}`). Accepted: the agent
  is explicit at every callsite, the Zod discriminator narrows at parse time,
  and a typo surfaces as "no such clientId in this batch" instead of silently
  matching nothing.

The owner's prior choices in this codebase point the same way:
`access.assertCanRead`'s `viaCapabilitySlug` parameter (ADR-0002 / ADR-0022) is
an explicit grant on a separate channel, never a heuristic read of the
request. The same principle applies here.

### 4. Cross-entity validation in the service, not a Zod `refine`

Per-field shape (string lengths, enum values, max array length, clientId
batch-wide uniqueness inside one arm) stays in Zod's `superRefine` — it is
declarative, transport-shared, and runs before any service code. But
**cross-entity** rules — every client-ref in `connections[]` must resolve to a
Component in this same batch, the `parent` chain must form a DAG, server-refs
must live in this Project — live in the service alongside the existing authz
check. ADR-0001 already establishes this posture for authz (cross-entity
"actor X can write resource Y" decisions are service concerns, not transport
concerns); this slice extends the same posture to semantic validation. Two
practical wins: (a) the validator can name **which clientId** participates in
a cycle, which Zod's path-based error reporting cannot, and (b) the
validator's read of the existing graph (foreign-Project server-ref detection)
runs inside the same transaction that does the writes, so a concurrent
delete of the named server id rolls back the whole batch.

### 5. Composition over reimplementation

`applyGraph` calls `createNode` / `connectNodes` per row inside one
transaction; it does not reimplement same-Canvas, no-self-Connection, no-dup,
or parent-existence invariants in a `createMany`-friendly form. The
alternative — pre-allocate cuids, fan out a `createMany` for Components and a
`createMany` for Edges, then re-derive each invariant in a batched query —
was considered and rejected. Correctness-by-construction (philosophy #6)
wins over the perf gain for a first release: the existing services own
exactly the invariants we want, including the prompt-injection-safe verbatim
title storage `createNode` already guarantees and the
`isEdgeDedupCollision`-narrowed P2002 catch `connectNodes` already does (the
ADR-0010 pattern). Rebuilding those in a batched form means a second copy of
each invariant, the same number of bugs to find, and the same review surface
to maintain — the philosophy #6 anti-pattern in its most seductive form.

The deferred optimization is **named** here: when measurement shows the O(N+M)
`db.project.findFirst` cost from per-row authz dominates transaction-holding
time, the service layer can extract private `createNodeUnauthorized` /
`connectNodesUnauthorized` helpers that skip the per-call `assertCanWrite` and
trust the once-per-batch top-level check. The seam is named, not built; the
optimization arrives when there is a number to point at, not before.

A second deferred optimization (client-side cuid pre-allocation so writes go
through `createMany`) is constrained by this ADR: if it lands, the
cuid-generator library must match what Prisma's `@default(cuid())` produces
column-for-column. A drift would mean inserts that nominally succeed but
produce ids the rest of the system reads as malformed. This constraint is
why the optimization is not built today.

### 6. Catalog interface evolution: `outputSchema` and `structuredContent`

`McpWriteToolDescriptor` gains optional `outputSchema?: z.ZodType` and
`ToolInvocationResult` gains optional `structured?: unknown`;
`registerArchitectureTools` threads both through to MCP SDK 1.26.0's
`outputSchema` / `structuredContent` so the agent reads
`{ idMap, componentCount, connectionCount }` as a structured field rather
than a JSON-encoded message blob. The existing four tools are unaffected —
both fields are optional with absent-equals-previous-behavior defaults. The
evolution is reusable: #38's `apply_graph` extension, #40 / #42's single-op
Flow / FlowRoute tools, and any future tool that returns structured data
plug in without further catalog change.

## Explicitly deferred

- **`batchKey` / idempotency.** Not in #20's AC; not a blocker. The tool
  description tells the agent to "read the architecture before retrying
  after a transport failure" — a successful but lost response means the
  batch did apply, and a `getCanvas` resource read is the cheap path to
  confirm. Idempotency is named as additive future work: a future
  `batchKey: string` field on `applyGraphInput` plus a unique
  `(projectId, batchKey)` row that records the materialized `idMap` would
  let a retried call return the same map. The seam is the same shape as
  ADR-0010's named-pattern de-dupe rules: a key, a unique partial index
  scoped to live rows, a service-primary check, a P2002 catch. Today's
  service composes existing single-op writers and inherits their idempotent
  no-op behaviour for matched-state retries; it does not yet collapse a
  whole batch under one key.

- **`ValidationErrorDetails`** as a generic typed-details envelope. Today's
  validation messages interpolate the offending clientIds directly into the
  human `message` (`Connection references clientId 'n42' that is not in this
batch.`), which is sufficient for the agent's correction loop. The shape
  for adding structured `details` on `ValidationError` is already anticipated
  by the comment in `src/server/architecture/errors.ts` (lines 103-114):
  when a future caller needs a discriminable validation channel — say, to
  distinguish "dangling ref" from "cycle" without parsing the message — the
  additive shape lands then with the same envelope pattern `ConflictError`
  uses.

- **Per-Project authz optimization.** Composition's O(N+M) `Project.findFirst`
  cost is bounded (one cached row per service call, all inside one
  transaction) and well under transaction-holding budgets at the
  per-arm cap (`max(500)` Components, `max(1000)` Connections). Optimize
  when measured, not before — and even then only by extracting private
  `*_unauthorized` helpers behind the top-level authz check, never by
  loosening the per-row authz on the public service surface.

## Forward-naming

- **#38 (Slice 5)** extends this ADR additively. The two new arms
  (`flows: []`, `routes: []`) join the schema beside `components` and
  `connections`; the flat `idMap` keyed by clientId admits Flows and
  FlowRoutes without renumbering because each row's `clientId` is unique
  batch-wide. The cross-arm dependency order (Components → Flows →
  Connections → FlowRoutes per the comment in `docs/plans/flow-routed-connections.md`)
  lives in the service's topological sort, **not** in the schema — the
  schema does not encode ordering, the service does. A future Connection
  arm that needs its own clientId (so a FlowRoute can name it) lands as a
  purely additive `clientId?: string` field on `applyGraphConnectionInput`,
  optional today so the wire is forward-compatible.

- **ADR-0024 (`moveNode` reject-orphaning)**: if a future `apply_graph`
  extension allows _updating_ existing Components' `parentId` rather than
  only creating new rows, the orphan-rejection rule must be honoured per
  row. The structured-details self-correction channel ADR-0024 settled on
  (`ConflictError.details.conflictingEdgeIds` naming the active Edges that
  block the move) is exactly the shape an update-arm of `apply_graph` would
  reuse — same `enrichBatchError` path, same `conflictingClientIds`
  augmentation when the failing slot has a clientId. Explicitly named so the
  future change is local: a reviewer who sees an `update` arm slipping into
  `apply_graph` without this rejection regresses this ADR.

## Consequences

- **The agent's mental model becomes "tell the server what you want; let it
  figure out the order."** A 30-Component / 60-Connection architecture is
  one round trip instead of 90 — the philosophy #1 waterfall the single-op
  tools forced disappears, and the agent's correction loop on an in-batch
  duplicate is a single retry with a fixed `clientId`, not a
  read-then-retry over many calls.

- **`conflictingClientIds` joins the named additive-details pattern.** It
  is the fourth key on `ConflictErrorDetails` (after `conflictingEdgeIds`,
  `conflictingFlowIds`, `conflictingFlowSpecIds`, and
  `conflictingFlowRouteIds`); ADR-0010's "service-primary + structured
  details + named P2002 catch" shape extends to the batch surface unchanged.
  The MCP write adapter (`toMcpWriteError`) reads `cause.details`
  generically and exposes the augmented detail under
  `data.archDetails`, so the agent sees both the server id of the blocking
  row and the input slot in its own batch that produced it.

- **The `outputSchema` / `structuredContent` seam is now reusable.** #38's
  `apply_graph` extension lands by appending arms to the input and entries
  to the output; #40 / #42's single-op Flow / FlowRoute tools that return
  structured ids plug in by setting `outputSchema` on their descriptor; any
  future tool returning structured data does the same. The catalog
  interface does not need to evolve again for this class of change.

- **The reviewable invariant "writes never reimplement service invariants"
  is preserved.** A future PR that introduces a batched `createMany`-style
  Component write inside `applyGraph` — bypassing `createNode` to win
  throughput — regresses this ADR. The seam for that optimization is named
  (private `*_unauthorized` helpers behind the top-level authz check); any
  other shape that loses the per-row invariants `createNode` /
  `connectNodes` guarantee is a reviewable regression. The same applies if a
  reviewer "tightens" cross-entity validation into a Zod `refine` and pulls
  it out of the service — Zod cannot name a cycle's participating
  clientIds, and a refine that runs before the transaction cannot read the
  live graph to detect foreign-Project server-refs. Both moves regress.

## Amendment — #67 (Flow arm scrub; `apply_spec` companion tool)

The "## Forward-naming" §#38 block above named `flows: []` and `routes: []`
as the next additive arms of `apply_graph`. With the Flow model retired
(#62 / ADR-0027/0028/0030) those arms never land. The `flows`/`routes`
additive promise is **retired**; the topological-sort and `idMap` shape
documented in §1–§2 stay correct unchanged for `components: []` and
`connections: []`. Future arms — if any — plug in by the same shape.

The Consequences "additive details" list named historical keys
(`conflictingFlowIds`, `conflictingFlowSpecIds`, `conflictingFlowRouteIds`)
that **never shipped**: `ConflictErrorDetails` currently carries
`conflictingEdgeIds`, `conflictingSpecIds`, and `conflictingClientIds`.
Reviewers reading the Consequences should mentally substitute the
surviving keys; the structural pattern (service-primary check + structured
details + named P2002 catch) is what is load-bearing, not the historical
key list.

`apply_spec` (#67) joins `WRITE_TOOLS` as the sixth `defineTool` descriptor
— a **companion** to `apply_graph`, not an arm of it. It wraps `applySpec`
(ADR-0029) — same `applySpecInput`, same per-row `changed[]`/`dropped[]`
resolution arrays the web modal drives, same atomic apply, same structured
result. The `outputSchema` + `structuredContent` seam this ADR established
(§6, lines 161–171) is reused unchanged: `applySpec`'s result rides on the
wire as a typed object, not as a JSON-encoded message blob. No catalog
interface evolution needed.
