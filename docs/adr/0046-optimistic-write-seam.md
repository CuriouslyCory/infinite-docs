# 46. The `optimisticWrite` seam — one owner for snapshot, dual-store write, reconcile, and conditional rollback

## Status

Accepted (#144).

**Builds on** [ADR-0004](0004-canvas-ssr-disabled-island.md): the Canvas is a
client-only island whose React Flow store is seeded once and is **not** re-seeded
by a query refetch — so every gesture must write the live store and its cache
mirror itself. **Builds on** [ADR-0032](0032-connect-to-gesture-node-keyed-reads-and-client-derived-optimism.md):
client-derived optimism with a manual `temp_ → real` reconcile of the store is
already the canvas's posture for cross-scope inserts. This ADR **amends neither** —
it does not change a read shape, a write path, or a derivation. It **names** the
two-store model both ADRs assume, and gives the snapshot → write → reconcile →
conditional-rollback lifecycle a single owner instead of ~13 inline copies.

## Context

The canvas island hand-copies the same five-step optimistic-write sequence at
roughly thirteen call sites: snapshot the prior value, write the React Flow store
**and** the `getCanvas` cache mirror together, fire the one mutation, reconcile
the temp id to the real one on success, and conditionally roll both stores back on
failure. No module owns this. The two parts most likely to be wrong — the
`temp_ → real` reconcile and the conditional rollback — live inline at every site,
each subtly re-deriving "did the cache still hold what we wrote?" and "which row do
I restore into?". Performance philosophy #1 (optimistic updates everywhere) rests
on this path being correct, and the boundary-proxy work (#148/#149) needs it as a
foundation, so the interface matters more than the line count it saves.

The model these call sites assume — but never state — is a **two-store** one:

- The **React Flow store is the source of truth during interaction.** It is what
  the user sees and drags; it is seeded once per scope (ADR-0004) and never
  re-seeded by a refetch.
- The **`getCanvas` query cache is the persistence mirror.** It is what a scope
  remount re-seeds from, so it must agree with the store after every gesture.
- Both are written together via `patchCanvas` (which preserves sibling keys, so a
  field write never clobbers an unrelated row) and must be rolled back together.

## Decision

### One seam owns the lifecycle; the caller owns the shapes

A pure, framework-free `optimisticWrite` core (`optimistic-write.ts`) takes a
caller-built descriptor and runs the lifecycle: `snapshot()` the prior value,
`apply()` the optimistic value to store + cache as an atomic pair, `await
mutate()`, and on rejection perform the conditional rollback. The core imports no
domain types and is generic over the snapshot type `TPrev`, so it ships inside the
client island without dragging the server graph across the `verbatimModuleSyntax`
boundary (ADR-0004) — callers supply concrete types through closures.

The seam boundary is deliberate:

- **Inside the seam:** snapshot, dual-store write, mutate, the conditional
  rollback, and the success-branch slot where `temp_ → real` reconcile of store +
  cache will land (deferred to #148; the success branch is the named extension
  point now).
- **Caller-owned:** the snapshot-read closure; each store's patch shape — in
  particular the edge write must rebuild via `restyledRFEdge`, because arrowheads
  live on the React Flow edge object, not in `data` (ADR-0027); the failure
  messaging (e.g. the interaction-conflict toast); and, critically, the doc-save
  `inflightDocSavesRef` serialization chain, which the seam **must not** absorb —
  it protects byte-stability of the serialized markdown (ADR-0015/0017) and only
  borrows the seam's conditional-rollback half, not its write/mutate flow.

### The conditional-rollback invariant (reviewable)

On mutation failure the seam restores the prior value **only if the cache still
holds the optimistic value** — never clobbering a newer concurrent edit that
landed while the mutation was in flight. The restore is **field-scoped against the
CURRENT cache row**, not a replay of a stale full-object snapshot: it merges the
one captured field back into whatever row the cache holds now, so a concurrent
sibling-field success (e.g. an edge label that succeeded while this interaction
write failed) survives the rollback intact. A full-object restore would resurrect
the sibling's pre-edit value and silently undo a successful write.

### Additive-growth contract for #148/#149

The seam is designed to grow without a rewrite:

- **Reconcile lands additively** on the success branch — the `temp_ → real`
  id remap of store + cache attaches where the comment now marks the slot, when
  the first real reconciling caller (create/add/embed/drag/connect writes)
  arrives in #148. No existing field-level caller reconciles, so no reconcile
  parameter exists yet (narrow-required inputs).
- **The conditional-rollback predicate generalizes** from today's scalar
  field-equality check to a caller-supplied per-entity `matches` predicate, so
  multi-entity cross-scope writes (#149) can ask "does each touched row still hold
  what we wrote?" with the same gating logic. This is an additive generalization
  of the existing predicate, not a new mechanism.

### Scope of this slice

#144 migrates only the **five field-level handlers** — rename, kind,
documentation, edge label, and edge interaction — which already share the
conditional-rollback shape. The add, embed, drag, and connect handlers keep their
own bespoke `temp_ → real` reconcile until #148; routing them through the seam is
gated on the reconcile extension point existing.

## Consequences

- **Reviewable invariant:** on failure, the seam rolls back **only when the cache
  still holds the optimistic value**, and the restore is **field-scoped against
  the current row** — never a stale full-object snapshot. A rollback that
  unconditionally restores, or that replays a captured full object, regresses this
  ADR (it clobbers a concurrent sibling-field success — the exact behavior the
  inline blocks were copied to preserve).
- **Reviewable invariant:** the store and its cache mirror are written together
  via `patchCanvas` (sibling-key-preserving) and rolled back together. A path that
  writes one without the other desyncs the live view from a remount's
  authoritative re-seed (ADR-0004).
- **Reviewable invariant:** the doc-save `inflightDocSavesRef` serialization chain
  stays caller-owned and is **not** absorbed into the seam — it borrows only the
  conditional-rollback half. Folding it in would break the byte-stability guarantee
  the chain exists to protect (ADR-0015/0017).
- The seam's correctness rests on **direct unit tests** of the core (node env,
  store + cache modeled as plain closures): happy path, conditional rollback fires,
  rollback skipped when a concurrent write moved the cache, current-row field-merge
  preserves a sibling's newer value, and the doc-path rollback parity. The five
  migrated handlers delete their inline rollback blocks; the running-app check
  (dev-browser) verifies one optimistic edit and a forced-failure rollback toast.
- #148 lands reconcile on the success branch and #149 generalizes the predicate —
  both additive. This ADR fixes the interface those slices build against.
