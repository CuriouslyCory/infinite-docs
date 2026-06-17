import { describe, expect, it, vi } from "vitest";

import {
  type OptimisticWrite,
  rollbackIfStillOptimistic,
  runOptimisticWrite,
} from "./optimistic-write";

// Model the store+cache as a plain mutable closure — no React, tRPC, or DB. A
// "row" is a single field value; the captured-prev shape used by rename/kind.
function makeFieldStore(initial: string | undefined) {
  let value = initial;
  return {
    read: () => value,
    write: (v: string | undefined) => {
      value = v;
    },
  };
}

describe("runOptimisticWrite", () => {
  it("happy path: applies once, resolves, never rolls back or errors", async () => {
    const store = makeFieldStore("A");
    const apply = vi.fn(() => store.write("B"));
    const rollback = vi.fn();
    const onError = vi.fn();

    // The success branch is the #148 reconcile extension point; today no caller
    // reconciles, so the final state is simply the optimistic value.
    const w: OptimisticWrite<string | undefined> = {
      snapshot: () => store.read(),
      apply,
      mutate: () => Promise.resolve("ok"),
      stillOptimistic: (prev) => store.read() === prev,
      rollback,
      onError,
    };

    await runOptimisticWrite(w);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(rollback).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(store.read()).toBe("B");
  });

  it("conditional rollback fires when the cache still holds the optimistic value", async () => {
    const store = makeFieldStore("A");
    const prev = store.read();
    const rollback = vi.fn((p: string | undefined) => store.write(p));
    const onError = vi.fn();
    const boom = new Error("mutate failed");

    const w: OptimisticWrite<string | undefined> = {
      snapshot: () => store.read(),
      apply: () => store.write("B"),
      mutate: () => Promise.reject(boom),
      stillOptimistic: () => store.read() === "B",
      rollback,
      onError,
    };

    await runOptimisticWrite(w);

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(rollback).toHaveBeenCalledWith(prev);
    expect(onError).toHaveBeenCalledWith(boom);
    expect(store.read()).toBe("A");
  });

  it("rollback SKIPPED when a concurrent write moved the cache; onError still fires", async () => {
    const store = makeFieldStore("A");
    const rollback = vi.fn();
    const onError = vi.fn();
    const boom = new Error("mutate failed");

    const w: OptimisticWrite<string | undefined> = {
      snapshot: () => store.read(),
      apply: () => store.write("B"),
      mutate: () => {
        // A newer write lands and succeeds before this one's rejection.
        store.write("C");
        return Promise.reject(boom);
      },
      stillOptimistic: () => store.read() === "B",
      rollback,
      onError,
    };

    await runOptimisticWrite(w);

    expect(rollback).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(store.read()).toBe("C");
  });

  it("current-row merge (edge shape): rollback restores only the captured field, preserving a concurrent sibling change", async () => {
    type Edge = { label: string | null; interaction: string };
    let row: Edge = { label: "old", interaction: "USES" };
    const prev = row;
    const onError = vi.fn();
    const boom = new Error("mutate failed");

    const w: OptimisticWrite<Edge> = {
      snapshot: () => row,
      apply: () => {
        row = { ...row, label: "new" };
      },
      mutate: () => {
        // Concurrent sibling-field success: interaction changed in the interim.
        row = { ...row, interaction: "DEPENDS_ON" };
        return Promise.reject(boom);
      },
      // Field-scoped predicate: cache still shows THIS write's label.
      stillOptimistic: () => row.label === "new",
      rollback: (p) => {
        // Merge only the captured field back into the CURRENT row.
        row = { ...row, label: p.label };
      },
      onError,
    };

    await runOptimisticWrite(w);

    expect(onError).toHaveBeenCalledWith(boom);
    expect(row.label).toBe("old");
    expect(row.interaction).toBe("DEPENDS_ON");
    expect(prev.interaction).toBe("USES");
  });
});

describe("rollbackIfStillOptimistic (doc-save path parity)", () => {
  it("rolls back and errors when still optimistic", () => {
    const store = makeFieldStore("doc-B");
    const rollback = vi.fn((p: string | undefined) => store.write(p));
    const onError = vi.fn();
    const boom = new Error("save failed");

    rollbackIfStillOptimistic(
      {
        stillOptimistic: () => store.read() === "doc-B",
        rollback,
        onError,
      },
      "doc-A",
      boom,
    );

    expect(rollback).toHaveBeenCalledWith("doc-A");
    expect(onError).toHaveBeenCalledWith(boom);
    expect(store.read()).toBe("doc-A");
  });

  it("skips rollback but still errors when no longer optimistic", () => {
    const store = makeFieldStore("doc-C");
    const rollback = vi.fn();
    const onError = vi.fn();
    const boom = new Error("save failed");

    rollbackIfStillOptimistic(
      {
        stillOptimistic: () => store.read() === "doc-B",
        rollback,
        onError,
      },
      "doc-A",
      boom,
    );

    expect(rollback).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(store.read()).toBe("doc-C");
  });
});
