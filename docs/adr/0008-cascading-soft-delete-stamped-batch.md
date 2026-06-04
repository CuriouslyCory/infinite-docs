# 8. Cascading Component soft-delete is one stamped batch, gathered by a single recursive descent

## Status

Accepted. _Amended by [ADR-0014](0014-deleteedge-restoreedge-cascade.md), which
extends this stamped-batch mechanism to the `deleteEdge` / `restoreEdge`
FlowRoute cascade (Slice 2 of flow-routed-connections) — the conditional
`deletionId`, the `restoreEdge` inverse, the additive `deleteNode` /
`restoreNode` FlowRoute arms, and the caller-supplied-transaction contract all
live there. The "lone delete" wording below still describes the no-FlowRoute
path correctly._

## Context

This slice realizes the **cascading soft-delete + undo** that CONTEXT.md ("Node",
"Soft-delete + undo") has named since M0 and deferred to M1. Deleting a
**Component** must remove its **Node**, its entire subtree, and every incident or
interior **Connection** in one operation, exclude all of it from reads, and be
**undoable** — restoring _exactly_ the affected set and nothing outside it. The
motivation is agent safety: an MCP server will let AI agents mutate the graph, so
destruction must be recoverable (CONTEXT.md "Soft-delete + undo").

Three questions bind later graph work and so earn a record:

1. **How is the subtree (and the set of Connections to remove) gathered?**
2. **How does undo know which rows one delete touched**, so it restores exactly
   that set — never more, never fewer?
3. **What models that "affected set" — a stored entity, or something lighter?**

## Decision

### The subtree is one recursive descent; the Edge sweep unions all three FK columns

`deleteNode` gathers the subtree in a **single `WITH RECURSIVE` query descending
`parentId`** — the mirror of `getCanvas`'s ascending breadcrumb walk — never a
per-level loop. It **reuses the ADR-0006 raw-SQL discipline** (double-quoted
PascalCase identifiers, bound parameters, `deletedAt IS NULL` on both arms) and is
the "second recursive read" ADR-0006 explicitly anticipated. Unlike the breadcrumb
walk, the cascade carries **no `depth` cap**: the graph is acyclic (no
`move`/reparent yet; `move` will own cycle prevention per the glossary), so the
recursion terminates on its own, and a cap could only ever _under_-gather —
truncating the cascade and silently orphaning a descendant under a deleted
ancestor, the precise failure this slice exists to prevent. Completeness beats a
cap; the fail-loud post-stamp guard (below) is the runaway backstop.
Reading the stored `parentId` tree does **not** violate ADR-0005's
"scope is explicit, not inferred" — ADR-0006 already carves out that traversing
the recorded nesting column is authoritative, not the forbidden edge-scope
inference.

The Edge sweep is **`sourceId ∈ S ∨ targetId ∈ S ∨ canvasNodeId ∈ S`** (S = the
subtree), **never `canvasNodeId` alone**. An _incident_ Connection from the
deleted Component up to a **surviving sibling** lives on the _parent's_ Canvas
(`canvasNodeId ∉ S`) yet must still be swept, or it dangles to a deleted endpoint
forever. ADR-0005 made all three Edge columns first-class precisely so this sweep
cannot be reduced to scope.

The recursive read and both `updateMany` sweeps run inside **one transaction**
(the router wraps the service in `db.$transaction`, like `updatePositions`), so
the delete is atomic.

### Undo identity is a stamped `deletionId`, not a shared timestamp

A delete mints **one fresh `deletionId`** and stamps it (alongside `deletedAt`) on
every row it transitions to deleted. `restoreNode` clears `deletedAt` **and**
`deletionId` for **exactly the rows bearing that id**. This is rejected:
**keying undo on the `deletedAt` timestamp** — two operations can collide on an
instant, and a row a user removed independently moments earlier could be revived
by matching its timestamp. The stamped id makes "the affected set" a _stored
fact_, not a reconstructed query.

Both the cascade's `updateMany`s filter `deletedAt: null`, so a Connection or
descendant **already removed by another operation** (a lone `deleteEdge`, which
sets `deletedAt` with no `deletionId`, or an earlier delete) is **never
re-stamped** — and therefore **never revived** by undoing this batch. Two
independent deletes carry distinct ids and undo independently.

### A bare column, not a `Deletion` entity (for now)

`deletionId` is a **nullable column on `Node` and `Edge`**, indexed for the
restore lookup — **no `Deletion` table**. Undo resolves the owning Project from
any stamped row (a delete always stamps at least its root Node) and authorizes
against it. This satisfies every acceptance criterion with the smallest footprint;
a durable `Deletion` entity (with `createdAt`, a "recent deletions" view, and a
stable handle for a future **MCP undo tool**) is **deferred** — the MCP delete
surface is itself deferred to a later release — and is an **additive** migration
if it is ever wanted, not a rewrite.

### Authorization and restore semantics

`deleteNode` and `restoreNode` are **owner-only writes** via
`access.assertCanWrite`; ownership comes from the **actor**, never the input, and
the capability slug never grants either (ADR-0001/0002). `deleteNode` authorizes
**before** walking the subtree (an intruder learns nothing about the graph's
shape, the ordering invariant the `createNode` tests already pin). Restore is
**as-is**: if an ancestor of a batch was independently deleted in a _later_
operation, undoing the batch restores its rows even though the subtree is briefly
unreachable via `getCanvas` until the ancestor is also restored — honoring
"restore exactly the affected set and nothing outside it" literally.

## Consequences

- **"The Edge sweep unions `sourceId`/`targetId`/`canvasNodeId`, never
  `canvasNodeId` alone" is a reviewable invariant.** Reducing it to scope is a
  regression that silently orphans every cross-boundary Connection.
- **"Undo restores only rows stamped with its `deletionId`, never a
  `deletedAt`-timestamp match" is a reviewable invariant**, in the same spirit as
  ADR-0005's "scope is explicit" and ADR-0006's "one recursive query." A future
  change that derives the undo set from timestamps regresses this ADR.
- **The `deletedAt: null` filter on the cascade is load-bearing, not incidental:**
  it is what keeps undo from over-restoring a row removed by another operation. A
  reviewer must not "simplify" it away.
- The `deletedAt IS NULL` filter on the recursive descent rests on the invariant
  that **no live Node ever sits under a soft-deleted ancestor** (a cascade sweeps
  the whole subtree, and `createNode` rejects a soft-deleted parent), so the walk
  never needs to pass _through_ a deleted Node to reach a live descendant.
- **`pnpm check` cannot see into the recursive SQL** (ADR-0006); a wrong
  identifier or casing fails only at runtime, so this slice's correctness rests on
  the service tests against **real Postgres** (ADR-0003). Running `pnpm test` is
  part of the Definition of Done, not optional.
- The sweep **interpolates no user-authored content** — only bound Node/Project
  ids — upholding the prompt-injection standing note (CONTEXT.md).
- Choosing a bare `deletionId` over a `Deletion` entity is the one place this slice
  optimizes for the present over a deferred future; the cost is that a later MCP
  undo tool or "recent deletions" view will likely promote the column to a real
  entity. That is an accepted, additive trade.
- **Concurrency posture (accepted window; hardening deferred to M4).** Two choices
  harden the cascade against the one outcome it must never produce — a _live Node
  under a soft-deleted ancestor_, the invariant the recursive descent's
  `deletedAt IS NULL` filter rests on. (1) The descent carries **no depth cap**, so
  it can never truncate and orphan a deep descendant. (2) After stamping, a
  **fail-loud post-stamp guard** (`assertNoOrphanedChildren`) re-checks for any live
  Node still sitting directly under the stamped set and throws `ConflictError`
  (→ TRPC `CONFLICT`), rolling the whole transaction back rather than persisting a
  silent orphan — retryable. The guard closes the depth-cap mode outright and
  best-effort-closes the concurrency one, but a **residual window** remains under
  READ COMMITTED: a `createNode` that commits a child between the guard's read and
  this transaction's commit is not caught. Today that window is **accepted** —
  writes are single-owner and the web client is optimistic, so concurrent writers
  to one graph do not yet exist. The named hardening path is **row-level locking**
  (`SELECT … FOR UPDATE` over the subtree in `deleteNode`, plus a parent-row lock in
  `createNode`), **deferred to M4** when the MCP server introduces concurrent agent
  writes and the window becomes reachable in practice. This mirrors ADR-0005's
  accepted-window precedent: name the race, accept it while it is unreachable, and
  point at the fix for when it is not.
