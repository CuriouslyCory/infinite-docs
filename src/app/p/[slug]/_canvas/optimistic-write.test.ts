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

// The #148 reconcile slot: success-only store work (temp→real remap / invalidate
// / undo-toast). These cover the create + multi-entity shapes the cross-scope
// handlers fold into the seam, modelled framework-free.
describe("runOptimisticWrite — reconcile (success branch)", () => {
  it("happy path WITH reconcile: reconcile runs once, after mutate, success-only", async () => {
    const calls: string[] = [];
    const rollback = vi.fn();
    const onError = vi.fn();

    const w: OptimisticWrite<{ reconciled: boolean }, string> = {
      snapshot: () => ({ reconciled: false }),
      apply: () => calls.push("apply"),
      mutate: () => {
        calls.push("mutate");
        return Promise.resolve("ok");
      },
      reconcile: () => calls.push("reconcile"),
      stillOptimistic: () => true,
      rollback,
      onError,
    };

    await runOptimisticWrite(w);

    // apply → mutate → reconcile, reconcile exactly once, no rollback/error.
    expect(calls).toEqual(["apply", "mutate", "reconcile"]);
    expect(rollback).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it("reconcile is NOT run on failure (and rollback fires instead)", async () => {
    const reconcile = vi.fn();
    const rollback = vi.fn();
    const onError = vi.fn();
    const boom = new Error("mutate failed");

    const w: OptimisticWrite<{ reconciled: boolean }, string> = {
      snapshot: () => ({ reconciled: false }),
      apply: () => undefined,
      mutate: () => Promise.reject(boom),
      reconcile,
      stillOptimistic: () => true,
      rollback,
      onError,
    };

    await runOptimisticWrite(w);

    expect(reconcile).not.toHaveBeenCalled();
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("reconcile receives the typed mutate result (TResult threads through)", async () => {
    type Created = { id: string; sourceId: string };
    let seen: Created | null = null;

    const w: OptimisticWrite<{ reconciled: boolean }, Created> = {
      snapshot: () => ({ reconciled: false }),
      apply: () => undefined,
      mutate: () => Promise.resolve({ id: "real_1", sourceId: "n1" }),
      reconcile: (result) => {
        seen = result;
      },
      stillOptimistic: () => true,
      rollback: vi.fn(),
      onError: vi.fn(),
    };

    await runOptimisticWrite(w);

    expect(seen).toEqual({ id: "real_1", sourceId: "n1" });
  });

  it("create rollback removes exactly the minted temp entity (never a concurrent insert)", async () => {
    // Model the node store as an id list; a create inserts a temp id, reconcile
    // would rewrite it to the real id, rollback filters the EXACT temp id.
    let nodes = ["n1"];
    const tempId = "temp_abc";
    const onError = vi.fn();
    const boom = new Error("create failed");

    const w: OptimisticWrite<{ reconciled: boolean }, { id: string }> = {
      snapshot: () => ({ reconciled: false }),
      apply: () => {
        nodes = [...nodes, tempId];
      },
      mutate: () => {
        // A concurrent insert lands while this create is in flight.
        nodes = [...nodes, "temp_other"];
        return Promise.reject(boom);
      },
      reconcile: vi.fn(),
      stillOptimistic: () => nodes.includes(tempId),
      rollback: () => {
        nodes = nodes.filter((n) => n !== tempId);
      },
      onError,
    };

    await runOptimisticWrite(w);

    // Only THIS gesture's temp id is filtered; the concurrent insert survives.
    expect(nodes).toEqual(["n1", "temp_other"]);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it("create rollback is SKIPPED when the temp was already reconciled (no clobber of concurrent success)", async () => {
    // The mutation succeeds and reconcile rewrites temp → real; a separate later
    // failing path must NOT remove the now-real id. Modelled by running the
    // success write, then asserting `stillOptimistic` would gate a stray rollback.
    let nodes = ["n1"];
    const tempId = "temp_abc";
    const rollback = vi.fn(() => {
      nodes = nodes.filter((n) => n !== tempId && n !== "real_1");
    });

    const w: OptimisticWrite<{ reconciled: boolean }, { id: string }> = {
      snapshot: () => ({ reconciled: false }),
      apply: () => {
        nodes = [...nodes, tempId];
      },
      mutate: () => Promise.resolve({ id: "real_1" }),
      reconcile: (real) => {
        nodes = nodes.map((n) => (n === tempId ? real.id : n));
      },
      // After reconcile the temp id is gone, so a stray rollback would be gated.
      stillOptimistic: () => nodes.includes(tempId),
      rollback,
      onError: vi.fn(),
    };

    await runOptimisticWrite(w);

    expect(nodes).toEqual(["n1", "real_1"]);
    // Reconcile cleared the temp id, so the gate now blocks any rollback.
    expect(w.stillOptimistic({ reconciled: true })).toBe(false);
    if (w.stillOptimistic({ reconciled: true })) w.rollback({ reconciled: true });
    expect(rollback).not.toHaveBeenCalled();
    expect(nodes).toEqual(["n1", "real_1"]);
  });

  it("multi-entity apply+rollback together; rep node removed only when addedRepNode (both branches)", async () => {
    // A cross-scope create inserts an edge + a per-edge proxy row, and adds the
    // coalesced rep NODE only when none yet stood in for the endpoint. Rollback
    // replays that exact decision from TPrev.
    type Store = { edges: string[]; proxyRows: string[]; repNodes: string[] };

    async function run(addedRepNode: boolean) {
      const store: Store = {
        edges: ["e0"],
        proxyRows: ["pr0"],
        // When NOT adding, a rep node already exists for the endpoint.
        repNodes: addedRepNode ? [] : ["rep_existing"],
      };
      const boom = new Error("connect failed");
      const w: OptimisticWrite<{ addedRepNode: boolean }, { id: string }> = {
        snapshot: () => ({ addedRepNode }),
        apply: () => {
          store.edges.push("temp_e");
          store.proxyRows.push("temp_pr");
          if (addedRepNode) store.repNodes.push("temp_rep");
        },
        mutate: () => Promise.reject(boom),
        reconcile: vi.fn(),
        stillOptimistic: () => store.edges.includes("temp_e"),
        rollback: (prev) => {
          store.edges = store.edges.filter((e) => e !== "temp_e");
          store.proxyRows = store.proxyRows.filter((p) => p !== "temp_pr");
          // Remove the rep node ONLY if this gesture added it (#90).
          if (prev.addedRepNode) {
            store.repNodes = store.repNodes.filter((r) => r !== "temp_rep");
          }
        },
        onError: vi.fn(),
      };
      await runOptimisticWrite(w);
      return store;
    }

    const added = await run(true);
    // Added branch: edge, proxy row, AND rep node all rolled back to start.
    expect(added).toEqual({ edges: ["e0"], proxyRows: ["pr0"], repNodes: [] });

    const joined = await run(false);
    // Joined branch: edge + proxy row gone, but the SHARED rep node survives.
    expect(joined).toEqual({
      edges: ["e0"],
      proxyRows: ["pr0"],
      repNodes: ["rep_existing"],
    });
  });

  it("coalesced survival: deleting one of two crossing edges keeps the shared proxy node", async () => {
    // Two edges cross to the same off-scope endpoint, coalescing onto ONE rep
    // node (ADR-0016). Deleting one edge drops its per-edge row but must NOT
    // remove the rep node a surviving sibling still needs.
    type Store = { edges: string[]; proxyRows: string[]; repNodes: string[] };
    const store: Store = {
      edges: ["e1", "e2"],
      // One per-edge proxy row per crossing edge, same endpoint.
      proxyRows: ["pr_e1", "pr_e2"],
      repNodes: ["rep_shared"],
    };

    // survivesElsewhere: another crossing edge still reaches the endpoint.
    const survivesElsewhere = store.proxyRows.some((p) => p !== "pr_e1");

    const w: OptimisticWrite<{ survivesElsewhere: boolean }, void> = {
      snapshot: () => ({ survivesElsewhere }),
      apply: () => {
        store.edges = store.edges.filter((e) => e !== "e1");
        store.proxyRows = store.proxyRows.filter((p) => p !== "pr_e1");
        // Remove the rep node ONLY when nothing else needs it.
        if (!survivesElsewhere) {
          store.repNodes = store.repNodes.filter((r) => r !== "rep_shared");
        }
      },
      mutate: () => Promise.resolve(),
      reconcile: vi.fn(),
      stillOptimistic: () => true,
      rollback: vi.fn(),
      onError: vi.fn(),
    };

    await runOptimisticWrite(w);

    expect(store.edges).toEqual(["e2"]);
    expect(store.proxyRows).toEqual(["pr_e2"]);
    // The shared rep node SURVIVES the deletion of one crossing edge.
    expect(store.repNodes).toEqual(["rep_shared"]);
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
