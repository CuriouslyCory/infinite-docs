import { describe, expect, it } from "vitest";

import { arrowEnds } from "./connection-direction";

/**
 * Pure-logic unit test (no database, no React Flow): drives `arrowEnds` across
 * every `Interaction` and asserts which ends bear an arrow. This is the
 * repurposed ADR-0023 four-case arrow matrix (ADR-0027) — the cases now assert
 * the arrow derived from the Connection's own interaction, not from a routed Flow.
 */
describe("arrowEnds", () => {
  it("points at the target for REQUEST (source calls target)", () => {
    expect(arrowEnds("REQUEST")).toEqual({ atSource: false, atTarget: true });
  });

  it("points at the target for PUSH (source emits to target)", () => {
    expect(arrowEnds("PUSH")).toEqual({ atSource: false, atTarget: true });
  });

  it("points at the source for SUBSCRIBE (source consumes target's stream)", () => {
    expect(arrowEnds("SUBSCRIBE")).toEqual({ atSource: true, atTarget: false });
  });

  it("points at both ends for DUPLEX (two-way)", () => {
    expect(arrowEnds("DUPLEX")).toEqual({ atSource: true, atTarget: true });
  });

  it("points at neither end for ASSOCIATION (a plain undirected line)", () => {
    expect(arrowEnds("ASSOCIATION")).toEqual({
      atSource: false,
      atTarget: false,
    });
  });
});
