"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * The **working trace** store (#57): a per-browser, per-Project set of
 * **trace point** Node ids, persisted to `localStorage`. It is deliberately
 * client-only and server-free — marking a Component is selection state, not a
 * write (ADR-0002), so this never reaches the service layer and imports nothing
 * from `~/server`.
 *
 * It lives ABOVE the canvas island so the two disjoint React trees that read it
 * — the canvas (detail-panel checkbox + node indicator) under `/p/[slug]` and
 * `/p/[slug]/n/[nodeId]`, and the separate Trace view at `/p/[slug]/trace` —
 * each mount their own provider. `localStorage` is the single source of truth
 * across those trees; a `storage`-event listener re-reads the key so a mark on
 * the canvas converges with a Trace view open in another tab.
 *
 * The store is intentionally narrow (CONTEXT.md "prefer narrow required
 * inputs"): it owns the point set and persistence only. Toast copy and the
 * "Open Trace view" decision live at the call site, which is why `toggle`
 * returns the resulting transition instead of coupling the store to `sonner`.
 * This is the seam #58 reads (to derive the on-path subgraph) and #59 extends
 * (to persist a working trace as a saved, named Trace).
 */

type TraceTransition = "added" | "removed";

type WorkingTrace = {
  tracePoints: ReadonlySet<string>;
  count: number;
  isTracePoint: (id: string) => boolean;
  toggle: (id: string) => TraceTransition;
  remove: (id: string) => void;
  clear: () => void;
  /**
   * Replaces the entire working set with `ids`, returning the PRIOR set so the
   * caller can offer an undo toast that restores it (restore is just
   * `replace(previous)` again). Narrow + required: the store owns the point set;
   * toast copy and the undo action live at the call site, the same seam as
   * `toggle` returning its transition.
   */
  replace: (ids: string[]) => { previous: string[] };
};

const WorkingTraceContext = createContext<WorkingTrace | null>(null);

const storageKeyFor = (projectId: string) => `infinite-docs:trace:${projectId}`;

function readStored(storageKey: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    // A corrupt value must never throw on mount — reset to empty.
    return new Set();
  }
}

export function WorkingTraceProvider({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  const storageKey = storageKeyFor(projectId);

  // Lazy-init straight from `localStorage`: `readStored` is SSR-guarded and
  // these islands are `ssr: false`, so the initializer runs client-side with no
  // hydration-flash and no setState-in-effect cascade. The set is keyed by
  // `projectId`, which is stable for a provider mount.
  const [tracePoints, setTracePoints] = useState<Set<string>>(() =>
    readStored(storageKey),
  );

  // Skip the write-through for the very first committed value (the lazy-init
  // read above) so hydration doesn't immediately re-serialize what it just read.
  const skipWriteThrough = useRef(true);

  // A ref mirroring the committed set so `toggle` can read live membership
  // *synchronously* and decide add-vs-remove outside the `setTracePoints`
  // updater — React may run that updater later and twice (StrictMode), so the
  // value it returns must not depend on the updater body running exactly once.
  // `toggle` advances it eagerly; this effect re-converges it after any other
  // path mutates the set (`remove`, `clear`, a cross-tab `storage` event).
  const tracePointsRef = useRef(tracePoints);
  useEffect(() => {
    tracePointsRef.current = tracePoints;
  }, [tracePoints]);

  useEffect(() => {
    if (skipWriteThrough.current) {
      skipWriteThrough.current = false;
      return;
    }
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...tracePoints]));
    } catch {
      // Storage full / disabled / private mode — the in-memory set still works
      // for this session; persistence is best-effort.
    }
  }, [storageKey, tracePoints]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      // The value already lives in `localStorage` (another tab wrote it); skip
      // the write-through so we don't echo it straight back.
      skipWriteThrough.current = true;
      setTracePoints(readStored(storageKey));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey]);

  const isTracePoint = useCallback(
    (id: string) => tracePoints.has(id),
    [tracePoints],
  );

  const toggle = useCallback((id: string): TraceTransition => {
    const current = tracePointsRef.current;
    const transition: TraceTransition = current.has(id) ? "removed" : "added";
    const next = new Set(current);
    if (transition === "removed") {
      next.delete(id);
    } else {
      next.add(id);
    }
    tracePointsRef.current = next;
    setTracePoints(next);
    return transition;
  }, []);

  // Reads the live set from the ref for `previous` (synchronous, StrictMode-safe,
  // same discipline as `toggle`), advances the ref eagerly, then sets the new
  // set; the write-through effect persists it to `localStorage`.
  const replace = useCallback((ids: string[]): { previous: string[] } => {
    const previous = [...tracePointsRef.current];
    const next = new Set(ids);
    tracePointsRef.current = next;
    setTracePoints(next);
    return { previous };
  }, []);

  const remove = useCallback((id: string) => {
    const current = tracePointsRef.current;
    if (!current.has(id)) return;
    const next = new Set(current);
    next.delete(id);
    tracePointsRef.current = next;
    setTracePoints(next);
  }, []);

  const clear = useCallback(() => {
    if (tracePointsRef.current.size === 0) return;
    const next = new Set<string>();
    tracePointsRef.current = next;
    setTracePoints(next);
  }, []);

  const value = useMemo<WorkingTrace>(
    () => ({
      tracePoints,
      count: tracePoints.size,
      isTracePoint,
      toggle,
      remove,
      clear,
      replace,
    }),
    [tracePoints, isTracePoint, toggle, remove, clear, replace],
  );

  return (
    <WorkingTraceContext.Provider value={value}>
      {children}
    </WorkingTraceContext.Provider>
  );
}

export function useWorkingTrace(): WorkingTrace {
  const ctx = useContext(WorkingTraceContext);
  if (ctx === null) {
    throw new Error("useWorkingTrace must be used within a WorkingTraceProvider");
  }
  return ctx;
}
