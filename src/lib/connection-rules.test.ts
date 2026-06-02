import { describe, expect, it } from "vitest";

import { canConnect } from "./connection-rules";

/**
 * The repo's first pure-logic unit test: it drives `canConnect` with plain
 * objects and asserts the returned outcome — no database, no React Flow. (The
 * vitest suite's `globalSetup` still syncs the test schema before any file
 * runs, so DATABASE_URL must be reachable to execute the suite; this test just
 * doesn't depend on it.) It asserts externally-observable behavior — what the
 * function returns for given inputs — never internal structure, mirroring the
 * style of `edge.service.test.ts` minus the Postgres harness.
 */
describe("canConnect", () => {
  it("accepts a Connection between two distinct Components", () => {
    expect(canConnect({ source: "a", target: "b" }, [])).toEqual({ ok: true });
  });

  it("accepts when no existing Connection shares the same endpoint pair", () => {
    const existing = [{ source: "c", target: "d" }];
    expect(canConnect({ source: "a", target: "b" }, existing)).toEqual({
      ok: true,
    });
  });

  it("rejects a self-link", () => {
    expect(canConnect({ source: "a", target: "a" }, [])).toEqual({
      ok: false,
      reason: "self-link",
    });
  });

  it("rejects a duplicate of an existing active Connection", () => {
    const existing = [{ source: "a", target: "b" }];
    expect(canConnect({ source: "a", target: "b" }, existing)).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });

  it("treats A→B and B→A as the same ASSOCIATION (unordered pair; ADR-0027)", () => {
    const existing = [{ source: "b", target: "a" }];
    expect(canConnect({ source: "a", target: "b" }, existing)).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });
});
