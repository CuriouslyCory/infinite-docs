# 30. Component cascade and undo without FlowRoutes; `deleteEdge` reverts to a lone soft-delete; a `Spec` sweep arm is added

## Status

Accepted (#62, the re-founding slice).

**Supersedes** [ADR-0014](0014-deleteedge-restoreedge-cascade.md) (the
`deleteEdge` / `restoreEdge` FlowRoute cascade) — the FlowRoute cascade is
deleted; `deleteEdge` reverts to the ADR-0008 lone soft-delete.

**Amends** [ADR-0008](0008-cascading-soft-delete-stamped-batch.md) (the
stamped-batch cascade): the `deleteNode` / `restoreNode` Flow + FlowSpec +
FlowRoute arms are removed; a `Spec` sweep arm is added; spec-derived child
Components ride the existing subtree descent. **Relates to**
[ADR-0011](0011-flows-as-first-class-component-owned.md) (the Flow / FlowSpec
foundation being retired) and
[ADR-0028](0028-cross-scope-connections-lineal-ingress.md) (the dropped
`canvasNodeId` that simplifies the Edge sweep).

## Context

ADR-0008 established the stamped-`deletionId` batch: `deleteNode` cascades the
Node, its subtree, incident/interior Edges, and (later, via ADR-0011/0014) owned
Flows + FlowSpec + incident FlowRoutes. ADR-0014 extended the same mechanism to
`deleteEdge` so sweeping a Connection swept its FlowRoutes.

#62 deletes Flow / FlowSpec / FlowRoute. Every cascade arm that touched them is
now dead code referencing dropped tables. The 1:1 spec row survives renamed as
**Spec** and must be swept with its owner Component.

The Edge sweep predicate in ADR-0008 unioned `canvasNodeId` (to catch incident
Connections living on a parent Canvas). With `canvasNodeId` dropped (ADR-0028),
the predicate simplifies to endpoint membership.

## Decision

### `deleteNode` / `restoreNode` drop the Flow/FlowSpec/FlowRoute arms; gain a `Spec` sweep arm

Stamp the owned `Spec` (1:1, `ownerNodeId @unique`) with the same `deletionId`;
`restoreNode` revives it in lockstep and pre-checks the `ownerNodeId @unique`
collision (a fresh Spec attached to the same Component since the delete blocks
the revival with a readable `ConflictError` carrying `conflictingSpecIds`).
Spec-derived child Components carry **no special arm** — they are ordinary
children swept by the existing subtree `parentId` descent.

*(In #62 nothing writes a `Spec` yet — the spec→Component generator is #64 — so
the Spec sweep and its restore pre-check are forward-compat, exercised by tests
that seed a `Spec` row directly. The same posture ADR-0012's inner-Edge
pre-check used before its writer landed.)*

### The Edge sweep predicate loses `canvasNodeId`

Now `sourceId ∈ S ∨ targetId ∈ S` over the subtree S. A Connection incident to
any swept Component — same-Canvas, cross-scope, or an "incident" one up to a
surviving sibling — touches a swept endpoint and is caught. With scope no longer
stored (ADR-0028), endpoint membership is the whole predicate, and it stays
complete precisely because there is no scope column to miss.

### `deleteEdge` reverts to a lone soft-delete

No FlowRoute cascade, no conditional `deletionId`, no shared-inner-Edge reference
counting. `deleteEdge` sets `deletedAt` on one Edge and mints **no** `deletionId`
— the ADR-0008 lone-delete carve-out, now the *only* `deleteEdge` path.
`restoreEdge` survives only as the cascade-restore helper driven by
`restoreNode` (it restores the Edges a `deleteNode` batch stamped, pre-checking
the two new de-dupe indexes — ADR-0027/0028).

## Consequences

- **Reviewable invariant:** *`deleteNode` stamps exactly {target Node, subtree,
  incident/interior Edges (by `sourceId`/`targetId` ∈ subtree), owned Spec} under
  one `deletionId`; `deleteEdge` is always a lone soft-delete with no
  `deletionId`. Re-introducing a FlowRoute arm, a conditional `deleteEdge`
  `deletionId`, or a shared-inner-Edge sweep references dropped tables and
  regresses this ADR.*
- The ADR-0012 `FOR UPDATE` inner-Edge race lock and reference-counted inner-Edge
  sweep are deleted — no shared pipe survives, so no last-referer race exists.
- The fail-loud post-stamp orphan guard (ADR-0008's `assertNoOrphanedChildren`)
  and the no-depth-cap subtree descent are **unchanged** — they protect the Node
  subtree, untouched by Flow retirement.
- Correctness still rests on service tests against real Postgres (ADR-0003): the
  cascade tests lose their Flow/FlowRoute cases and gain a Spec-sweep case and a
  cross-scope-incident-Edge sweep case.
