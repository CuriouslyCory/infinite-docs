import { describe, expect, it } from "vitest";

import type { ParsedComponent, ParsedConnection } from "~/lib/schemas";
import {
  MAX_PARSED_CONNECTIONS,
  MAX_PARSED_NODES,
  MAX_TREE_DEPTH,
  enforceBounds,
} from "../bounds";

function chain(depth: number): ParsedComponent[] {
  let current: ParsedComponent | null = null;
  for (let i = depth; i >= 1; i -= 1) {
    const node: ParsedComponent = {
      specKey: `n${i}`,
      kind: "GENERIC",
      title: `n${i}`,
    };
    if (current !== null) node.children = [current];
    current = node;
  }
  return current === null ? [] : [current];
}

describe("enforceBounds", () => {
  it("accepts a small tree", () => {
    expect(enforceBounds(chain(3), [])).toEqual({ ok: true });
  });

  it("rejects when depth exceeds the safety bound", () => {
    const result = enforceBounds(chain(MAX_TREE_DEPTH + 1), []);
    expect(result.ok).toBe(false);
  });

  it("rejects when node count exceeds the safety bound", () => {
    const tree: ParsedComponent[] = Array.from(
      { length: MAX_PARSED_NODES + 1 },
      (_, i) => ({ specKey: `n${i}`, kind: "GENERIC", title: `n${i}` }),
    );
    const result = enforceBounds(tree, []);
    expect(result.ok).toBe(false);
  });

  it("rejects on duplicate specKey across the tree", () => {
    const result = enforceBounds(
      [
        { specKey: "dup", kind: "ENDPOINT", title: "a" },
        { specKey: "dup", kind: "ENDPOINT", title: "b" },
      ],
      [],
    );
    expect(result.ok).toBe(false);
  });

  it("accepts connections whose endpoints are present in the tree", () => {
    const tree: ParsedComponent[] = [
      { specKey: "a", kind: "TABLE", title: "a" },
      { specKey: "b", kind: "TABLE", title: "b" },
    ];
    const connections: ParsedConnection[] = [
      {
        specKey: "fk1",
        sourceKey: "a",
        targetKey: "b",
        interaction: "REQUEST",
      },
    ];
    expect(enforceBounds(tree, connections)).toEqual({ ok: true });
  });

  it("rejects a connection whose endpoint is absent from the tree", () => {
    const tree: ParsedComponent[] = [
      { specKey: "a", kind: "TABLE", title: "a" },
    ];
    const connections: ParsedConnection[] = [
      {
        specKey: "fk1",
        sourceKey: "a",
        targetKey: "missing",
        interaction: "REQUEST",
      },
    ];
    expect(enforceBounds(tree, connections).ok).toBe(false);
  });

  it("rejects a self-link connection (same component on both ends)", () => {
    const tree: ParsedComponent[] = [
      { specKey: "a", kind: "TABLE", title: "a" },
    ];
    const connections: ParsedConnection[] = [
      {
        specKey: "fk1",
        sourceKey: "a",
        targetKey: "a",
        interaction: "REQUEST",
      },
    ];
    expect(enforceBounds(tree, connections).ok).toBe(false);
  });

  it("rejects duplicate connection specKeys", () => {
    const tree: ParsedComponent[] = [
      { specKey: "a", kind: "TABLE", title: "a" },
      { specKey: "b", kind: "TABLE", title: "b" },
    ];
    const connections: ParsedConnection[] = [
      {
        specKey: "dup",
        sourceKey: "a",
        targetKey: "b",
        interaction: "REQUEST",
      },
      {
        specKey: "dup",
        sourceKey: "b",
        targetKey: "a",
        interaction: "REQUEST",
      },
    ];
    expect(enforceBounds(tree, connections).ok).toBe(false);
  });

  it("rejects when connection count exceeds the safety bound", () => {
    const tree: ParsedComponent[] = [
      { specKey: "a", kind: "TABLE", title: "a" },
      { specKey: "b", kind: "TABLE", title: "b" },
    ];
    const connections: ParsedConnection[] = Array.from(
      { length: MAX_PARSED_CONNECTIONS + 1 },
      (_, i) => ({
        specKey: `fk${i}`,
        sourceKey: "a",
        targetKey: "b",
        interaction: "REQUEST" as const,
      }),
    );
    expect(enforceBounds(tree, connections).ok).toBe(false);
  });
});
