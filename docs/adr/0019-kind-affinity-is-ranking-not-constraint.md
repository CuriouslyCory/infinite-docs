# 19. Kind affinity is a UI ranking, not a constraint

## Status

Accepted (Slice 1 of the kind-palette work). Depends on
[ADR-0018](0018-nodekind-expanded-taxonomy-stays-cosmetic.md) (the expanded
`NodeKind` taxonomy stays cosmetic) and
[ADR-0001](0001-service-layer-db-actor-input.md) (the single-round-trip service
contract).

## Context

With 26 Component kinds (ADR-0018), a flat alphabetical picker buries the right
choice. The product wants the picker to be _context-aware_: inside a `DATABASE`,
promote `TABLE` / `STORED_PROCEDURE`; inside a `HOST`, promote `CONTAINER` /
`SERVICE` / `MICROSERVICE` / `CRON`; at the Project root, promote
infrastructure-flavored kinds. We call the parent-kind → suggested-child-kinds
relation **kind affinity**.

The danger is that "the picker suggests `TABLE` inside a `DATABASE`" slides into
"the system _requires_ `TABLE` inside a `DATABASE`." That would re-introduce
exactly the behavioural meaning ADR-0018 forbids kind from carrying. The
question this ADR settles: where does affinity live, and how strong is it?

## Decision

### Affinity is presentation-only ranking

Kind affinity orders the **kind palette** and nothing else:

- Affined kinds render under a "Suggested" group; every other kind renders under
  "All kinds". The union is always the full `NodeKind` set, so search reaches any
  kind regardless of affinity.
- The service layer is unchanged: `createNode` (and Slice 2's `updateNodeKind`)
  accept **any** `kind` under **any** parent, exactly as before. There is no
  `assertKindAllowedUnder`, no validation that consults the parent's kind.
- Therefore kind stays cosmetic (ADR-0018): affinity is a hint about what is
  _common_, never a rule about what is _allowed_.

### The map is a client-side constant

`KIND_AFFINITY` is a `Record<NodeKind | "ROOT", readonly NodeKind[]>` in
`~/lib/node-kinds.ts` — colocated with `KIND_LABEL` / `KIND_ICON`, keyed
exhaustively so a new kind must be given an affinity row (an empty list is a
valid "no affinity" answer). The Project root, which has no parent Component and
thus no `NodeKind` to key on, uses the sentinel string `"ROOT"`.

The picker reads the current scope's parent kind from
`breadcrumbs.at(-1)?.kind ?? null` — `getCanvas` carries `kind` on each breadcrumb
entry, so the parent kind arrives in the **same round trip** as the rest of the
Canvas (ADR-0001 / ADR-0006). No second query, no per-open fetch.

## Alternatives considered

- **Prisma-enforced child-kind whitelist** (a table or check constraint). Rejected:
  makes kind behavioural, regressing ADR-0018; turns a cosmetic relabelling into a
  migration; and forbids legitimate models (a `FUNCTION` documented as a child of a
  `DATABASE` row's trigger, say).
- **Service-side `assertKindAllowedUnder(parentKind, kind)`.** Rejected for the same
  reason — it is the same constraint one layer up, and it would make the MCP/agent
  path reject graphs a human can draw.
- **Server-derived suggestions on `getCanvas`** (the service computes and returns the
  ranked list per scope). Rejected: the ranking is a pure function of two kinds —
  identical for every project, user, and scope — so shipping it per read is payload
  bloat with zero information, and it drags a presentation concern into the data
  layer. The constant lives where it is consumed.
- **Name it "kind suggestions" / "kind ranking" / "nesting rules".** Rejected:
  "suggestions" names the UI output, not the underlying relation; "ranking" names the
  mechanism; "nesting rules" / "parent-child constraints" actively imply enforcement
  that does not exist. **Affinity** names the relation — a directional pull of one
  kind toward others — with no is-a / must-be / contains semantics, matching the
  precision of "polarity" and "origin" already in the glossary.

## Consequences

- **The escape hatch is structural.** Because affinity never restricts, a user whose
  vocabulary diverges from ours (`LAMBDA`, `WORKER`, `DAEMON`) still picks any kind in
  one search keystroke, or falls back to `GENERIC` + a free-text title. We never have
  to chase every vocabulary to keep the picker usable.
- **A reviewer "tightening" affinity into a rule regresses this ADR.** The signal is
  this file plus the `KIND_AFFINITY` doc comment; `pnpm check` will not catch the
  regression because adding a service-side kind check still type-checks.
- **Affinity edits are cheap and low-risk.** Re-ordering or re-pointing a row is a
  one-line change to a constant with no schema, service, or test impact — it cannot
  break a graph, only re-rank a list.
- **`getCanvas` breadcrumbs now carry `kind`.** A one-column widening of the recursive
  breadcrumb query (ADR-0006); the breadcrumb **bar** does not render it yet, but the
  Component-detail panel's re-kind affordance (Slice 2) reads the _parent's_ kind from
  the second-to-last entry, so the shape serves both. A reviewer dropping `kind` from
  the breadcrumb shape to "slim the payload" breaks the picker's affinity lookup.
