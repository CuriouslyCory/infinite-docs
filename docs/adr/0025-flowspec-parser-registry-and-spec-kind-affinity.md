# 25. FlowSpec parsing is a kind-keyed registry; spec-kind affinity ranks, not constrains

## Status

Accepted. Extends [ADR-0011](0011-flows-as-first-class-component-owned.md) (Flows
are first-class, Component-owned, materialized from a FlowSpec by a bounded
parse-on-write) and reuses the posture of
[ADR-0019](0019-kind-affinity-is-ranking-not-constraint.md) (affinity is a UI
ranking, never a constraint) and
[ADR-0023](0023-connection-direction-derived-from-flows.md) (a Connection is
undirected; arrowheads derive from each routed Flow's interaction).

## Context

"Attach spec" shipped (ADR-0011) with a single OpenAPI parser; every other
`FlowSpecKind` (`ASYNCAPI` / `TS_SIGNATURE` / `GRAPHQL` / `CUSTOM`) persisted its
source and recorded a `parseError` placeholder. In practice the feature only made
sense on API-flavored Components, and the paste UI offered all five raw enum
values on every Component regardless of kind — a `NETWORK` was invited to attach
an OpenAPI document.

We want every Component kind to accept a spec that *makes sense for that kind*: a
`DATABASE` takes SQL DDL whose tables route through the diagram exactly as API
operations do; a `TOPIC` takes AsyncAPI channels; a `SERVICE` takes TypeScript
signatures. The data model already supports this — `FlowSpec → Flow → FlowRoute`
is entirely kind-agnostic, and `getCanvas`/`flow-direction` derive arrows from the
**interaction** enum with no branch on `FlowKind`, so a new flow kind routes on the
canvas the instant it exists. The OpenAPI-specificity lived in exactly two places:
the parser and the picker. This ADR settles how parsing generalizes and how the
picker becomes kind-aware without making kind behavioral.

## Decision

### Parsing is a registry of pure, bounded parsers

`src/server/architecture/flow-parser.ts` became a folder. The public surface is
unchanged — `parseFlowSpec(kind, source): ParseFlowSpecResult`, still pure (no
`db`, no `actor`), still never throwing. Internally:

- `flow-parser/shared.ts` holds the security-load-bearing primitives every parser
  reuses: the UTF-8 byte cap, the iterative depth walk, the YAML/JSON loader that
  resolves **no** `$ref`/anchor. `FlowSpec.source` is UNTRUSTED (prompt-injection
  standing note, parse-time clause), so "bounded" is not optional.
- `flow-parser/parsers/{openapi,asyncapi,graphql,sql-ddl,ts-signature}.ts` each
  export a `SpecParser = (source) => ParseFlowSpecResult`, enforce a count cap,
  and catch every library throw into a sanitized `parseError`.
- `flow-parser/index.ts` dispatches through
  `const REGISTRY: Record<FlowSpecKind, SpecParser | null>`. The exhaustive
  `Record` is the compile guard: a new `FlowSpecKind` fails the build until it has
  a registry entry — the same exhaustiveness discipline the parity guards
  (`flow.service.ts`) and the kind catalogs (`~/lib/node-kinds`, `~/lib/spec-kinds`)
  use. `null` means "no parser" — today only `CUSTOM` (hand-authored prose).

Adding a routable spec format is therefore a localized, type-checked change: one
parser module plus one registry line. `flow.service.ts` is untouched — it already
writes whatever `kind`/`interaction`/`signature` the parser returns.

### Interaction is owner-relative, derived per parser (not naively per verb)

Each parser sets a Flow's **interaction** from the owning Component's perspective
(ADR-0023), which is occasionally inverted from the document's verb. The load-
bearing case is AsyncAPI v2: per the 2.x spec, `publish` describes messages
*consumed by* the application and `subscribe` describes messages *produced by* it,
so the owner-relative mapping is `publish → SUBSCRIBE`, `subscribe → PUSH` — the
opposite of the intuitive reading. AsyncAPI v3's explicit `action` removes the
ambiguity (`send → PUSH`, `receive → SUBSCRIBE`). GraphQL subscriptions stream
outward (`PUSH`); queries/mutations are `REQUEST`. SQL tables and TS callables are
`REQUEST` (a consumer reads/calls the owner). Getting this right at parse time is
what makes the derived arrowheads correct with zero kind-specific rendering code.

### The picker is kind-aware; affinity ranks, never constrains

`~/lib/spec-kinds.ts` adds `SPEC_KIND_AFFINITY: Record<NodeKind, readonly
FlowSpecKind[]>` (exhaustive, so a new `NodeKind` must declare its spec affinity),
`SPEC_KIND_LABEL`, and `SPEC_KIND_PLACEHOLDER`. `specKindsFor(kind)` returns the
affined structured kinds plus `CUSTOM` as a universal fallback — but only when the
list is non-empty, so infra/structural kinds (`NETWORK`, `REGION`, …) return an
empty list and the Attach-spec section **hides entirely**.

Critically, this is presentation-only, exactly as ADR-0019 made Component-kind
affinity presentation-only. `attachFlowSpec` accepts **any** `FlowSpecKind` on any
Component — there is no `assertSpecKindAllowedFor`. Spec kind is orthogonal to the
cosmetic Component kind; the picker decides what is *offered*, never what is
*allowed*. The module is client-safe (imports only `~/lib/schemas`), so it loads
in the Canvas island without dragging the server graph into the browser bundle
(ADR-0004).

## Alternatives considered

- **Spec → child Components instead of Flows** (a SQL schema explodes into `TABLE`
  sub-nodes with FK Connections). Rejected for this work: the product ask was
  "routable like API endpoints," which *is* the Flow model, and it reuses the
  entire Flow → FlowRoute → canvas → (future) markdown stack. Spec-to-subgraph
  generation remains a possible separate feature; FK → Connection materialization
  is recorded in the `signature` but deferred.
- **A `switch (kind)` inside one parser file** rather than a registry. Rejected:
  the exhaustive `Record` makes "every kind has a parser-or-null" a compile
  invariant; a `switch` with a `default` silently swallows a new kind.
- **Service- or Prisma-enforced spec-kind-per-Component-kind whitelist.** Rejected
  for the same reason ADR-0019 rejected it for Component kinds: it makes kind
  behavioral, breaks the MCP/agent path that a human UI can draw, and turns a
  re-rank into a migration.
- **Naive per-verb interaction** (AsyncAPI `publish → PUSH`). Rejected: it renders
  the arrow backwards against the v2 spec's own semantics. The owner-relative
  mapping is the whole point of the interaction enum.

## Consequences

- **New routable formats are cheap and contained.** A parser module + a registry
  line + a `signature` shape; the routing, palette, direction, and (pending #38)
  markdown machinery are kind-agnostic and need no edit.
- **New runtime dependencies, server-only.** `graphql` and `node-sql-parser` were
  added, and `typescript` was promoted from `devDependencies` to `dependencies`
  (the TS-signature parser uses `ts.createSourceFile` — syntax-only: no `Program`,
  no checker, no `CompilerHost`, so no filesystem access and no execution). All
  three are reachable only through `flow-parser` → `flow.service.ts` (the server
  graph) and never enter a `"use client"` island — verified by `pnpm build`, since
  `pnpm check` alone would not catch a bundle leak.
- **Flows still do not render in markdown/MCP.** That is #38. The new `FlowKind`s
  (`DB_TABLE`, `GRAPHQL_FIELD`) must be handled when that lands; they do not block
  here because canvas routing is kind-agnostic.
- **A reviewer "tightening" spec-kind affinity into a service check regresses this
  ADR** — the signal is this file plus the `SPEC_KIND_AFFINITY` doc comment, and
  `pnpm check` will not catch it because a service-side check still type-checks (the
  same caveat ADR-0019 carries).
