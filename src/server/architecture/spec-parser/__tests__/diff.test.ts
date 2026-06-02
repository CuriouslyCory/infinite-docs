import { describe, expect, it } from "vitest";

import type { ParsedComponent } from "~/lib/schemas";
import { flattenParsed, parseSpecDiff } from "../diff";

function ep(specKey: string, title = specKey): ParsedComponent {
  return { specKey, kind: "ENDPOINT", title };
}

describe("flattenParsed", () => {
  it("walks pre-order and threads the parent specKey", () => {
    const tree: ParsedComponent[] = [
      {
        specKey: "a",
        kind: "TABLE",
        title: "a",
        children: [
          { specKey: "a.col1", kind: "GENERIC", title: "col1" },
          { specKey: "a.col2", kind: "GENERIC", title: "col2" },
        ],
      },
      ep("b"),
    ];
    const flat = flattenParsed(tree);
    expect(flat.map((f) => f.specKey)).toEqual(["a", "a.col1", "a.col2", "b"]);
    expect(flat[1]?.parentSpecKey).toBe("a");
    expect(flat[3]?.parentSpecKey).toBe(null);
  });
});

describe("parseSpecDiff", () => {
  it("classifies new / changed / dropped by specKey", () => {
    const tree = [ep("listPets", "List the pets"), ep("createPet")];
    const existing = [
      {
        id: "n1",
        specKey: "listPets",
        title: "List",
        kind: "ENDPOINT" as const,
        metadata: null,
      },
      {
        id: "n2",
        specKey: "deletePet",
        title: "Delete",
        kind: "ENDPOINT" as const,
        metadata: null,
      },
    ];

    const diff = parseSpecDiff(tree, existing);
    expect(diff.new.map((n) => n.specKey)).toEqual(["createPet"]);
    expect(diff.changed.map((c) => c.specKey)).toEqual(["listPets"]);
    expect(diff.changed[0]?.changedFields).toEqual(["title"]);
    expect(diff.dropped.map((d) => d.nodeId)).toEqual(["n2"]);
    expect(diff.matchedKeyToId).toEqual({ listPets: "n1" });
  });

  it("treats undefined / null / empty metadata as equal", () => {
    const tree = [{ specKey: "x", kind: "ENDPOINT" as const, title: "x" }];
    const existing = [
      {
        id: "n1",
        specKey: "x",
        title: "x",
        kind: "ENDPOINT" as const,
        metadata: {},
      },
    ];
    const diff = parseSpecDiff(tree, existing);
    expect(diff.changed).toHaveLength(0);
  });

  it("reports a kind change as changed", () => {
    const tree = [ep("e1")];
    const existing = [
      {
        id: "n1",
        specKey: "e1",
        title: "e1",
        kind: "GENERIC" as const,
        metadata: null,
      },
    ];
    const diff = parseSpecDiff(tree, existing);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]?.changedFields).toEqual(["kind"]);
  });
});
