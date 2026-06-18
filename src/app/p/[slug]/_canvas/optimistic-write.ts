/**
 * One optimistic write, framework-free and generic over `TPrev` (the rollback
 * snapshot) and `TResult` (the mutation's resolved value) so the core imports NO
 * domain types — callers supply concrete types via closures, sidestepping the
 * `verbatimModuleSyntax` server-graph boundary entirely (this module ships in the
 * Canvas client island).
 *
 * The same seam drives field edits (rename/kind/label/interaction) AND the heavy
 * cross-scope writes (create/connect/delete): a multi-entity caller folds its
 * per-entity bookkeeping into a composite `TPrev`, so `stillOptimistic` stays a
 * single `(prev) => boolean` predicate and `rollback` a single closure (ADR-0046).
 */
export interface OptimisticWrite<TPrev, TResult = unknown> {
  /** Capture the prior value BEFORE the optimistic write (for rollback). */
  snapshot: () => TPrev;
  /** Write the optimistic value to the store + cache mirror (atomic pair). */
  apply: () => void;
  /** The one tRPC mutation for this gesture; its result threads into `reconcile`. */
  mutate: () => Promise<TResult>;
  /**
   * Post-success store work, run INSIDE the try after `mutate` resolves: the
   * temp→real id remap of a create, a background cache invalidate, an undo-toast
   * keyed by the result — anything that must happen ONLY when the mutation
   * succeeded. Omitted by field-level callers, which have nothing to reconcile.
   */
  reconcile?: (result: TResult) => void;
  /** True iff the cache STILL holds what we wrote — gates rollback. */
  stillOptimistic: (prev: TPrev) => boolean;
  /** Restore `prev` into the CURRENT row(s) (store + cache). */
  rollback: (prev: TPrev) => void;
  onError: (error: unknown) => void;
}

/**
 * Drives the optimistic-write lifecycle: snapshot the prior value, write the
 * optimistic one to BOTH the React Flow store and the query-cache mirror (kept
 * atomic so interaction and persistence views never diverge), run the mutation,
 * `reconcile` on success, and on failure roll back CONDITIONALLY.
 *
 * `reconcile` runs inside the try, after `mutate` resolves, so it sees ONLY the
 * success branch and never fires when the mutation threw. A multi-entity create
 * uses it for the temp→real id remap (plus the background invalidate); a delete
 * uses it for the post-success invalidate (and undo toast). A caller that needs
 * a delete's already-deleted (`NOT_FOUND`) case to count as success absorbs that
 * inside its own `mutate` closure (catch → resolve), so the seam still runs
 * `reconcile` and skips rollback — `stillOptimistic` is reserved for the
 * concurrent-edit case, not "already gone."
 *
 * Rollback is conditional — and field-scoped against the CURRENT cache row, not
 * the snapshot — to avoid clobbering a concurrent write: a fast rename A→B can
 * overlap a failing A→B′, and an unconditional restore to the pre-A snapshot
 * would undo B's successful optimistic patch. `stillOptimistic` gates this so we
 * only roll back when the cache still shows exactly what THIS write put there. A
 * create rolls back by filtering its EXACT minted temp id, never clobbering a
 * concurrent insert.
 */
export async function runOptimisticWrite<TPrev, TResult = unknown>(
  w: OptimisticWrite<TPrev, TResult>,
): Promise<void> {
  const prev = w.snapshot();
  w.apply();
  try {
    const result = await w.mutate();
    w.reconcile?.(result);
  } catch (error) {
    rollbackIfStillOptimistic(w, prev, error);
  }
}

/**
 * The conditional-rollback half, reused by the serialized doc-save path so the
 * gating logic lives in exactly ONE place (and one test covers both callers).
 */
export function rollbackIfStillOptimistic<TPrev>(
  w: Pick<OptimisticWrite<TPrev>, "stillOptimistic" | "rollback" | "onError">,
  prev: TPrev,
  error: unknown,
): void {
  if (w.stillOptimistic(prev)) w.rollback(prev);
  w.onError(error);
}
