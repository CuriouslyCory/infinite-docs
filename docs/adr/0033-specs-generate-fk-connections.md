# 33. Specs generate FK Connections: edge provenance and auto-reconcile

## Status

Accepted (#76).

**Completes** [ADR-0029](0029-specs-generate-components-recursive-parse-diff-merge.md)
and [ADR-0025](0025-flowspec-parser-registry-and-spec-kind-affinity.md): both
named "FK → Connection materialization" as the deferred half of Spec-driven
generation. ADR-0029 made a SQL DDL Spec explode into TABLE + column Components
but drew none of the relationships; this ADR draws them.

**Builds on** [ADR-0027](0027-connection-carries-its-own-interaction.md) (a
Connection carries its own `interaction`; FK edges use `REQUEST`),
[ADR-0028](0028-cross-scope-connections-lineal-ingress.md) (Connections need no
stored scope), and [ADR-0008](0008-cascading-soft-delete-stamped-batch.md) (the
existing `deleteNode` edge sweep is by endpoint, so a spec-derived edge incident
to a deleted table is swept and restored with no new arm).

## Context

A SQL DDL Spec's foreign keys are the architecture's dependency edges, but
`applySpec` created only Nodes. Two gaps had to close to draw them:

1. **The parser discarded FKs.** It read `PRIMARY KEY` to flag columns and
   ignored every `FOREIGN KEY` — including the out-of-line `ALTER TABLE … ADD
   CONSTRAINT … FOREIGN KEY` statements Prisma emits for *every* relation.

2. **An Edge had no Spec provenance.** A Node carries `sourceSpecId` + `specKey`
   so a re-parse can re-identify and reconcile it; an Edge carried neither, so
   there was no way to know which Connections a Spec owns — and therefore no way
   to drop one when its FK disappears, or to avoid duplicating it on re-apply.

## Decision

### Edge gains `sourceSpecId` + `specKey`, mirroring Node

The Edge analogue of the Node provenance columns (`onDelete: SetNull` so
deleting the Spec orphans provenance, never the Connection). A hand-drawn
Connection leaves both null; a spec-derived one carries the Spec id and the
parser's stable per-Connection identity. This is what makes re-import a
reconcile rather than an append.

### One Connection per ordered table pair, not per FK

A Connection models a dependency arrow between two Components, and the directional
de-dupe index (`projectId, sourceId, targetId, interaction`) forbids parallel
`REQUEST` edges between the same ordered pair. So the parser merges all FKs
sharing a `(referencing, referenced)` pair into ONE `ParsedConnection` whose
`specKey` is `source->target` and whose label lists the columns — three FKs
`Edge→Node` (canvasNodeId, sourceId, targetId) become one arrow labeled with all
three columns, not three colliding edges. A **self-referential** FK (a table
referencing itself, e.g. `Node.parentId → Node`) is skipped: the no-self-link
invariant (`connectNodes`) forbids a Connection from a Component to itself.

### FK Connections are AUTO-reconciled — no user resolution

Components surface a NEW/CHANGED/DROPPED modal because they hold user-owned
content (documentation, position, hand-drawn incident Connections) that a
re-parse must not silently destroy. A spec-derived FK Connection holds **no user
content** — it is a pure derivation of the source. So `applySpec` reconciles
Connections automatically after the Component phase: create the new ones (with
provenance), soft-delete the ones whose FK vanished, refresh interaction/label on
changed ones. The preview surfaces only informational create/remove counts.

### Slot-adoption instead of duplicate-or-fail

When the parser would draw a Connection into a `(source, target, REQUEST)` slot
already held by an active Edge (a hand-drawn Connection, or one from another
Spec), `applySpec` STAMPS that Edge with this Spec's provenance and refreshes its
label rather than inserting a duplicate the de-dupe index would reject. The Spec
adopts the existing arrow and reconciles it on future re-parses — the same
"reuse the live row" posture `upsertLiveSpec` uses for the Spec itself.

### Interaction: `REQUEST`, referencing → referenced

An FK is a directional dependency: the table holding the column depends on the
table it references. `REQUEST` (arrow at the referenced table) reads as "depends
on / references", the natural FK semantics.

## Consequences

- Importing a SQL DDL Spec now draws the dependency graph, not just the tables —
  the payoff the tool exists for (an LLM and the canvas both read the edges).
- Re-import is idempotent and subtractive: re-running an unchanged migration is a
  no-op; removing an FK and re-applying removes exactly its Connection.
- Adoption means a Spec can "claim" a Connection a user drew first; this is
  intentional (the Spec becomes the source of truth for that dependency) and is
  reflected in the create count.
- Self-referential FKs draw nothing. A hierarchical/recursive table relationship
  (a common, legitimate pattern) is not represented as a Connection — acceptable
  because the tool has no self-loop edge, and the nesting it implies is better
  modeled by descent than by a self-arrow.
- Edges with provenance ride the existing soft-delete cascade and undo unchanged:
  deleting a generated table sweeps its incident FK Connections; undo restores
  them. The provenance columns are inert to that machinery.
