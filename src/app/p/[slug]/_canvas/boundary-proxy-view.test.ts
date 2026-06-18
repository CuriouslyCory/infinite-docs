import { describe, expect, it } from "vitest";

import type { CanvasBoundaryProxy, ProjectComponent } from "~/lib/types";

import type { CanvasRFNode } from "./canvas";
import {
  coalesceProxies,
  existingProxyNodeIdFor,
  placedProxyNodes,
  RAIL_X,
  railOccupants,
  railPosition,
  repOnScope,
  survivingProxies,
} from "./boundary-proxy-view";

// A per-edge boundary-proxy row as getCanvas emits it (ADR-0031), built as a plain
// object so the tests stay framework- and DB-free. `nodeId` is the synthetic
// `proxy_<edgeId>`; `edgeId` is `temp_…` while the crossing edge is still optimistic.
function proxy(
  overrides: Partial<CanvasBoundaryProxy> &
    Pick<CanvasBoundaryProxy, "nodeId" | "edgeId" | "realEndpointId">,
): CanvasBoundaryProxy {
  return {
    title: "Host",
    kind: "SERVICE",
    posX: null,
    posY: null,
    ...overrides,
  };
}

function comp(id: string, parentId: string | null): ProjectComponent {
  return { id, title: id, kind: "SERVICE", parentId };
}

describe("coalesceProxies", () => {
  it("folds rows sharing a realEndpointId onto ONE rep + remaps every member", () => {
    const proxies = [
      proxy({ nodeId: "proxy_e1", edgeId: "e1", realEndpointId: "host" }),
      proxy({ nodeId: "proxy_e2", edgeId: "e2", realEndpointId: "host" }),
      proxy({ nodeId: "proxy_e3", edgeId: "e3", realEndpointId: "other" }),
    ];

    const { reps, remap } = coalesceProxies(proxies);

    expect(reps).toHaveLength(2);
    const repFor = (real: string) =>
      reps.find((r) => r.realEndpointId === real)!.nodeId;
    expect(repFor("host")).toBe("proxy_e1");
    expect(remap.get("proxy_e1")).toBe("proxy_e1");
    expect(remap.get("proxy_e2")).toBe("proxy_e1");
    expect(remap.get("proxy_e3")).toBe("proxy_e3");
  });

  it("rep is the lexicographically-smallest REAL nodeId, ignoring temp members", () => {
    // proxy_b is the smaller nodeId but its edge is still optimistic; the real
    // proxy_z must win so the rep id never churns out from under routed edges.
    const proxies = [
      proxy({ nodeId: "proxy_b", edgeId: "temp_b", realEndpointId: "host" }),
      proxy({ nodeId: "proxy_z", edgeId: "z", realEndpointId: "host" }),
    ];

    const { reps, remap } = coalesceProxies(proxies);

    expect(reps[0]!.nodeId).toBe("proxy_z");
    expect(remap.get("proxy_b")).toBe("proxy_z");
    expect(remap.get("proxy_z")).toBe("proxy_z");
  });

  it("falls back to a temp rep only when the WHOLE group is optimistic", () => {
    const proxies = [
      proxy({ nodeId: "proxy_y", edgeId: "temp_y", realEndpointId: "host" }),
      proxy({ nodeId: "proxy_x", edgeId: "temp_x", realEndpointId: "host" }),
    ];

    const { reps } = coalesceProxies(proxies);

    expect(reps[0]!.nodeId).toBe("proxy_x");
  });

  it("keeps the REAL rep stable across a temp → real reconcile (the fragile invariant)", () => {
    // Before: one real edge (z) + one optimistic edge (temp_b). Rep is the real z.
    const before = coalesceProxies([
      proxy({ nodeId: "proxy_b", edgeId: "temp_b", realEndpointId: "host" }),
      proxy({ nodeId: "proxy_z", edgeId: "z", realEndpointId: "host" }),
    ]);
    expect(before.reps[0]!.nodeId).toBe("proxy_z");

    // After: temp_b reconciles to a real edge whose proxy nodeId is proxy_a (now
    // lexicographically smaller). The rep is allowed to settle to the smallest REAL
    // nodeId — what must NOT happen is the rep flipping to a temp member.
    const after = coalesceProxies([
      proxy({ nodeId: "proxy_a", edgeId: "a", realEndpointId: "host" }),
      proxy({ nodeId: "proxy_z", edgeId: "z", realEndpointId: "host" }),
    ]);
    expect(after.reps[0]!.nodeId).toBe("proxy_a");
    expect(after.reps[0]!.edgeId.startsWith("temp_")).toBe(false);
  });

  it("orders reps deterministically regardless of input order", () => {
    const a = proxy({
      nodeId: "proxy_a",
      edgeId: "a",
      realEndpointId: "alpha",
    });
    const b = proxy({ nodeId: "proxy_b", edgeId: "b", realEndpointId: "beta" });
    const c = proxy({
      nodeId: "proxy_c",
      edgeId: "c",
      realEndpointId: "gamma",
    });

    const order1 = coalesceProxies([a, b, c]).reps.map((r) => r.realEndpointId);
    const order2 = coalesceProxies([c, a, b]).reps.map((r) => r.realEndpointId);

    expect(order1).toEqual(["alpha", "beta", "gamma"]);
    expect(order2).toEqual(order1);
  });
});

describe("rail layout", () => {
  it("railPosition seeds the i-th unplaced slot at x=RAIL_X, y=i*72", () => {
    expect(railPosition(0)).toEqual({ x: RAIL_X, y: 0 });
    expect(railPosition(2)).toEqual({ x: RAIL_X, y: 144 });
  });

  it("placedProxyNodes seeds placed proxies at their coord and unplaced down the rail", () => {
    const placed = proxy({
      nodeId: "proxy_placed",
      edgeId: "p",
      realEndpointId: "placedEp",
      posX: 500,
      posY: 320,
    });
    const unplacedA = proxy({
      nodeId: "proxy_u1",
      edgeId: "u1",
      realEndpointId: "ep1",
    });
    const unplacedB = proxy({
      nodeId: "proxy_u2",
      edgeId: "u2",
      realEndpointId: "ep2",
    });

    const nodes = placedProxyNodes([placed, unplacedA, unplacedB], new Set());

    // The placed proxy keeps its stored coord and consumes NO rail slot, so the two
    // unplaced ones take the first two rail slots (y=0, y=72).
    expect(nodes[0]!.position).toEqual({ x: 500, y: 320 });
    expect(nodes[1]!.position).toEqual({ x: RAIL_X, y: 0 });
    expect(nodes[2]!.position).toEqual({ x: RAIL_X, y: 72 });
  });

  it("placedProxyNodes seeds the rail from railBase (incremental add)", () => {
    const unplaced = proxy({
      nodeId: "proxy_u",
      edgeId: "u",
      realEndpointId: "ep",
    });

    const nodes = placedProxyNodes([unplaced], new Set(), 3);

    expect(nodes[0]!.position).toEqual({ x: RAIL_X, y: 3 * 72 });
  });

  it("railOccupants counts only boundary-proxy nodes sitting ON the rail", () => {
    const nodes: CanvasRFNode[] = [
      {
        id: "proxy_on1",
        type: "boundary-proxy",
        position: { x: RAIL_X, y: 0 },
        data: {
          title: "A",
          kind: "SERVICE",
          realEndpointId: "a",
          lineal: false,
        },
      },
      {
        id: "proxy_on2",
        type: "boundary-proxy",
        position: { x: RAIL_X, y: 72 },
        data: {
          title: "B",
          kind: "SERVICE",
          realEndpointId: "b",
          lineal: false,
        },
      },
      // Placed proxy off the rail — not counted.
      {
        id: "proxy_off",
        type: "boundary-proxy",
        position: { x: 400, y: 100 },
        data: {
          title: "C",
          kind: "SERVICE",
          realEndpointId: "c",
          lineal: false,
        },
      },
      // A Component that happens to share the rail x — not a boundary proxy, not counted.
      {
        id: "comp1",
        type: "component",
        position: { x: RAIL_X, y: 200 },
        data: {
          title: "Comp",
          kind: "SERVICE",
          optimistic: false,
          isPortal: false,
        },
      },
    ];

    expect(railOccupants(nodes)).toBe(2);
  });
});

describe("existingProxyNodeIdFor", () => {
  it("finds the live coalesced node id for a realEndpointId, or null", () => {
    const nodes: CanvasRFNode[] = [
      {
        id: "proxy_rep",
        type: "boundary-proxy",
        position: { x: RAIL_X, y: 0 },
        data: {
          title: "Host",
          kind: "SERVICE",
          realEndpointId: "host",
          lineal: false,
        },
      },
    ];

    expect(existingProxyNodeIdFor(nodes, "host")).toBe("proxy_rep");
    expect(existingProxyNodeIdFor(nodes, "absent")).toBeNull();
  });
});

describe("survivingProxies", () => {
  it("an endpoint survives iff some proxy reaching it has a retained edge", () => {
    const proxies = [
      proxy({ nodeId: "proxy_e1", edgeId: "e1", realEndpointId: "host" }),
      proxy({ nodeId: "proxy_e2", edgeId: "e2", realEndpointId: "host" }),
      proxy({ nodeId: "proxy_e3", edgeId: "e3", realEndpointId: "other" }),
    ];

    // Two edges reach `host`; retain only one → host still present.
    expect(survivingProxies(proxies, new Set(["e1"])).has("host")).toBe(true);
    // Retain none of host's edges → host absent.
    expect(survivingProxies(proxies, new Set(["e3"])).has("host")).toBe(false);
    expect(survivingProxies(proxies, new Set(["e3"])).has("other")).toBe(true);
    expect(survivingProxies(proxies, new Set()).size).toBe(0);
  });

  it("equals the old survivesElsewhere boolean for a deleted edge", () => {
    const proxies = [
      proxy({ nodeId: "proxy_e1", edgeId: "e1", realEndpointId: "host" }),
      proxy({ nodeId: "proxy_e2", edgeId: "e2", realEndpointId: "host" }),
    ];
    const allEdgeIds = new Set(proxies.map((p) => p.edgeId));

    // Deleting e1: another edge (e2) still reaches host → survivesElsewhere === true.
    const retainedAfterDeletingE1 = new Set(allEdgeIds);
    retainedAfterDeletingE1.delete("e1");
    expect(survivingProxies(proxies, retainedAfterDeletingE1).has("host")).toBe(
      true,
    );

    // Deleting both: nothing else reaches host → survivesElsewhere === false.
    const single = [
      proxy({ nodeId: "proxy_only", edgeId: "only", realEndpointId: "host" }),
    ];
    const retainedAfterDeletingOnly = new Set<string>();
    expect(
      survivingProxies(single, retainedAfterDeletingOnly).has("host"),
    ).toBe(false);
  });

  it("survives an endpoint with a sibling edge when several incident edges drop at once", () => {
    // Mirrors removeComponent: a node's incident edges {i1, i2, i3} are removed
    // together. `host` also has a non-incident sibling edge (s1) → host survives;
    // `gone` is reached only by incident edges → it orphans.
    const proxies = [
      proxy({ nodeId: "proxy_i1", edgeId: "i1", realEndpointId: "host" }),
      proxy({ nodeId: "proxy_i2", edgeId: "i2", realEndpointId: "gone" }),
      proxy({ nodeId: "proxy_i3", edgeId: "i3", realEndpointId: "gone" }),
      proxy({ nodeId: "proxy_s1", edgeId: "s1", realEndpointId: "host" }),
    ];
    const incidentEdgeIds = new Set(["i1", "i2", "i3"]);
    const retained = new Set(
      proxies.map((p) => p.edgeId).filter((id) => !incidentEdgeIds.has(id)),
    );

    const surviving = survivingProxies(proxies, retained);
    expect(surviving.has("host")).toBe(true);
    expect(surviving.has("gone")).toBe(false);
  });
});

describe("repOnScope", () => {
  // Tree: root → a → b → c ; sibling x under root.
  const byId = new Map<string, ProjectComponent>([
    ["a", comp("a", null)],
    ["b", comp("b", "a")],
    ["c", comp("c", "b")],
    ["x", comp("x", null)],
  ]);

  it("returns the target itself when it is interior to the scope", () => {
    expect(repOnScope("b", "a", byId)).toBe("b");
  });

  it("returns the ancestor whose parent IS the scope for a deeper target", () => {
    expect(repOnScope("c", "a", byId)).toBe("b");
  });

  it("returns null when the scope is off the target's ancestor chain", () => {
    expect(repOnScope("c", "x", byId)).toBeNull();
  });

  it("handles the root scope (scopeId === null) for a top-level target", () => {
    expect(repOnScope("a", null, byId)).toBe("a");
  });

  it("returns null for a top-level target viewed from a non-root scope", () => {
    expect(repOnScope("a", "x", byId)).toBeNull();
  });

  it("fuses on a malformed cycle in byId rather than looping forever", () => {
    const cyclic = new Map<string, ProjectComponent>([
      ["p", comp("p", "q")],
      ["q", comp("q", "p")],
    ]);
    expect(repOnScope("p", "scope", cyclic)).toBeNull();
  });
});
