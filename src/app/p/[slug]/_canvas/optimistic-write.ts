/**
 * One field-level optimistic write, framework-free and generic over `TPrev` so
 * the core imports NO domain types (callers supply concrete types via closures,
 * sidestepping the `verbatimModuleSyntax` server-graph boundary entirely — this
 * module ships in the Canvas client island).
 */
export interface OptimisticWrite<TPrev> {
  /** Capture the prior value BEFORE the optimistic write (for rollback). */
  snapshot: () => TPrev;
  /** Write the optimistic value to the store + cache mirror (atomic pair). */
  apply: () => void;
  /** The one tRPC mutation for this gesture. */
  mutate: () => Promise<unknown>;
  /** True iff the cache STILL holds what we wrote — gates rollback. */
  stillOptimistic: (prev: TPrev) => boolean;
  /** Restore `prev` into the CURRENT row (store + cache). */
  rollback: (prev: TPrev) => void;
  onError: (error: unknown) => void;
}

/**
 * Drives the optimistic-write lifecycle: snapshot the prior value, write the
 * optimistic one to BOTH the React Flow store and the query-cache mirror (kept
 * atomic so interaction and persistence views never diverge), run the mutation,
 * and on failure roll back CONDITIONALLY.
 *
 * Rollback is conditional — and field-scoped against the CURRENT cache row, not
 * the snapshot — to avoid clobbering a concurrent write: a fast rename A→B can
 * overlap a failing A→B′, and an unconditional restore to the pre-A snapshot
 * would undo B's successful optimistic patch. `stillOptimistic` gates this so we
 * only roll back when the cache still shows exactly what THIS write put there.
 *
 * Reconcile (temp→real id rewrite of store+cache) is deferred to #148 and lands
 * additively on the success branch when the first create caller needs it; the
 * five field-level handlers that use this seam today never reconcile.
 */
export async function runOptimisticWrite<TPrev>(
  w: OptimisticWrite<TPrev>,
): Promise<void> {
  const prev = w.snapshot();
  w.apply();
  try {
    await w.mutate();
    // #148 extension point: temp→real reconcile of store+cache lands here.
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
