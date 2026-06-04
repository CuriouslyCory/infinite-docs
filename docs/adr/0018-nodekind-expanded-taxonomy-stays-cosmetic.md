# 18. The expanded `NodeKind` taxonomy stays cosmetic

## Status

Accepted (Slice 1 of the kind-palette work). Reaffirms the cosmetic-kind
invariant first stated in [CONTEXT.md "Component kind"] across a much larger
value set. Read alongside
[ADR-0019](0019-kind-affinity-is-ranking-not-constraint.md) (kind affinity is a
UI ranking, not a constraint), which depends on this one.

## Context

The `NodeKind` enum shipped with six values (`GENERIC`, `SERVICE`, `DATABASE`,
`EXTERNAL_API`, `HOST`, `QUEUE`) — enough to colour the top of an architecture
graph, but not enough to model the hierarchy the product is built for: a user
descends from global infrastructure → data centers → networks → hosts →
containers → services → applications → modules → classes → functions →
variables/branches, and wants a Component kind at each tier. Inside a `DATABASE`
they expect `TABLE` and `STORED_PROCEDURE`; inside a `FUNCTION`, `BRANCH` and
`VARIABLE`.

This slice expands the enum from 6 to 26 values. The expansion is the moment a
contributor first asks the dangerous question — _"now that `DATABASE` exists and
`TABLE` exists, shouldn't a `TABLE` only be creatable inside a `DATABASE`?"_ —
i.e. should kind start constraining the graph. The answer must be on record
before someone "tightens" it, because the entire data model rests on kind being
inert.

## Decision

### The 20 new kinds

Added, tiered by where they sit in the hierarchy:

- **Global / regional:** `GLOBAL_INFRA`, `REGION`
- **Physical / network:** `DATACENTER`, `NETWORK` (joining the existing `HOST`)
- **Runtime:** `CONTAINER`, `MICROSERVICE`, `CRON` (joining `SERVICE`, `QUEUE`)
- **Software:** `APPLICATION`, `MODULE`, `CLASS`, `FUNCTION`, `VARIABLE`, `BRANCH`
- **Data:** `TABLE`, `STORED_PROCEDURE` (joining `DATABASE`)
- **Interface:** `ENDPOINT`, `WEBHOOK` (joining `EXTERNAL_API`)
- **Messaging:** `TOPIC`, `CONSUMER`, `PRODUCER`

`GENERIC` remains the default and the escape hatch: a Component whose real kind
the taxonomy does not name is `GENERIC` with a free-text title, never a forced
mis-fit.

### Kind stays cosmetic — at any size

The invariant is unchanged and explicitly reaffirmed across the larger surface:
kind drives only the Component's **icon**, **colour**, **label**, and the **kind
affinity** ranking the picker offers (ADR-0019). It confers **no** behavioural or
authorization meaning. Concretely, no kind:

- grants or denies nesting (`createNode` accepts any `kind` under any `parentId`
  regardless of the parent's kind — a `TABLE` inside a `SERVICE` is as valid as a
  `SERVICE` inside a `TABLE`),
- gates any service operation (connect, route, delete, export all ignore kind),
- alters de-dupe or any invariant in ADR-0005 / ADR-0010.

Two Components differing only in kind are otherwise identical.

### One value set, four lockstep maps, two guards

The value set lives in exactly one authoritative place per layer, kept in
lockstep by exhaustive `Record<…>` types that fail `pnpm check` on drift:

- **Zod `nodeKind`** (`~/lib/schemas`) — the client-safe source of truth.
- **Prisma `NodeKind`** (`prisma/schema.prisma`) — mirrored; the service-layer
  parity guard (`_zodKindIsPrismaKind` / `_prismaKindIsZodKind`,
  `Record<NodeKind, PrismaNodeKind>` both ways) fails to compile if the two
  enums diverge.
- **`KIND_LABEL`, `KIND_ICON`, `KIND_AFFINITY`** (`~/lib/node-kinds`) — each
  `Record<NodeKind, …>`, so a new Zod value cannot ship without a label, an
  icon, and an affinity row.
- **`KIND_LABEL`** in the markdown serializer (`~/server/architecture/markdown.ts`)
  — a deliberate server-side copy keyed by `PrismaNodeKind`, because the client
  catalog imports `lucide-react`, which must never reach the pure serializer
  (ADR-0017). The exhaustive `Record<PrismaNodeKind, string>` forces a new kind
  to be labelled there too.

Adding kind N+1 is therefore a closed checklist the compiler enforces: one Zod
row, one Prisma row, two parity-array rows, one label, one icon, one affinity
row, one serializer label. No code-path branch is ever required.

## Consequences

- **A new kind is additive and mechanical.** The compiler names every site that
  must be touched; there is no behaviour to wire.
- **"Should kind X only nest inside kind Y" is answered: no.** A reviewer
  proposing a Prisma constraint, a service-side `assertKindAllowedUnder`, or any
  kind-gated branch regresses this ADR. Such a rule belongs nowhere — see
  ADR-0019 for why even the _picker_ only ranks, never restricts.
- **The picker does not get unusable at 26 kinds** because the kind palette is
  search-first and affinity-ranked (ADR-0019); the flat `<select>` it replaced
  would have. Should the enum grow toward terminal-leaf sprawl
  (`PARAMETER`, `STATEMENT`, …), the palette — not the enum — owns the
  scaling answer (e.g. a collapsed "All kinds" section).
- **Icon coverage is a real constraint.** Every kind needs a distinct, legible
  `lucide-react` glyph. The current set is covered; a future kind with no obvious
  glyph is a reason to reconsider admitting it, not to ship a duplicate icon that
  reads as a different kind. (`STORED_PROCEDURE` and `SERVICE` currently share the
  `Cog` glyph — acceptable because their labels disambiguate and they rarely
  co-occur; a dedicated glyph is a welcome future polish.)
- **Markdown export stays byte-stable (ADR-0017).** New kinds widen the label map
  but change no existing fixture's output; the golden file is untouched because
  its fixtures use only the original kinds.
