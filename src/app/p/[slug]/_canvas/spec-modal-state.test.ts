import { describe, expect, it } from "vitest";

import {
  dismissModal,
  openPreview,
  specModalReducer,
  type SpecModalState,
} from "./spec-modal-state";

// A stub preview type stands in for `RouterOutputs["architecture"]["previewSpec"]`
// — the reducer is generic over it and never inspects its shape.
type Preview = { tag: string };

const closed: SpecModalState<Preview> = { status: "closed" };

const previewingA: SpecModalState<Preview> = {
  status: "previewing",
  ownerNodeId: "A",
};

describe("specModalReducer", () => {
  it("open → previewing for the owner", () => {
    expect(specModalReducer(closed, openPreview("A"))).toEqual(previewingA);
  });

  it("open supersedes a prior previewing/error and clears it", () => {
    const error: SpecModalState<Preview> = {
      status: "error",
      ownerNodeId: "A",
      message: "boom",
    };
    expect(specModalReducer(error, openPreview("B"))).toEqual({
      status: "previewing",
      ownerNodeId: "B",
    });
  });

  it("resolve(error) on the active owner → error", () => {
    expect(
      specModalReducer(previewingA, {
        type: "resolve",
        ownerNodeId: "A",
        result: { kind: "error", message: "bad spec" },
      }),
    ).toEqual({ status: "error", ownerNodeId: "A", message: "bad spec" });
  });

  it("resolve(firstAttach) on the active owner → applying", () => {
    expect(
      specModalReducer(previewingA, {
        type: "resolve",
        ownerNodeId: "A",
        result: { kind: "firstAttach" },
      }),
    ).toEqual({ status: "applying", ownerNodeId: "A" });
  });

  it("resolve(modal) on the active owner → modal carrying preview + pending", () => {
    const preview: Preview = { tag: "diff" };
    expect(
      specModalReducer(previewingA, {
        type: "resolve",
        ownerNodeId: "A",
        result: {
          kind: "modal",
          preview,
          pending: { kind: "OPENAPI", source: "src" },
        },
      }),
    ).toEqual({
      status: "modal",
      ownerNodeId: "A",
      preview,
      pending: { kind: "OPENAPI", source: "src" },
    });
  });

  it("firstAttach path: previewing → applying → closed", () => {
    const applying = specModalReducer(previewingA, {
      type: "resolve",
      ownerNodeId: "A",
      result: { kind: "firstAttach" },
    });
    expect(applying).toEqual({ status: "applying", ownerNodeId: "A" });
    expect(
      specModalReducer(applying, {
        type: "appliedFirstAttach",
        ownerNodeId: "A",
      }),
    ).toEqual({ status: "closed" });
  });

  describe("owner-guard: a STALE resolve is dropped (state referentially unchanged)", () => {
    // While previewing B, a late result for A (the user moved on) must not act.
    const previewingB: SpecModalState<Preview> = {
      status: "previewing",
      ownerNodeId: "B",
    };

    it("stale error result is dropped", () => {
      const next = specModalReducer(previewingB, {
        type: "resolve",
        ownerNodeId: "A",
        result: { kind: "error", message: "stale" },
      });
      expect(next).toBe(previewingB);
    });

    it("stale modal result is dropped", () => {
      const next = specModalReducer(previewingB, {
        type: "resolve",
        ownerNodeId: "A",
        result: {
          kind: "modal",
          preview: { tag: "stale" },
          pending: { kind: "OPENAPI", source: "stale" },
        },
      });
      expect(next).toBe(previewingB);
    });

    it("stale firstAttach result is dropped", () => {
      const next = specModalReducer(previewingB, {
        type: "resolve",
        ownerNodeId: "A",
        result: { kind: "firstAttach" },
      });
      expect(next).toBe(previewingB);
    });

    it("resolve when not previewing at all is dropped", () => {
      const next = specModalReducer(closed, {
        type: "resolve",
        ownerNodeId: "A",
        result: { kind: "firstAttach" },
      });
      expect(next).toBe(closed);
    });

    it("open then stale drop: open B supersedes A, then A's late result is dropped", () => {
      const previewing = specModalReducer(previewingA, openPreview("B"));
      const next = specModalReducer(previewing, {
        type: "resolve",
        ownerNodeId: "A",
        result: { kind: "error", message: "late" },
      });
      expect(next).toBe(previewing);
    });
  });

  describe("dismiss → closed from every state", () => {
    const states: SpecModalState<Preview>[] = [
      closed,
      previewingA,
      { status: "applying", ownerNodeId: "A" },
      { status: "error", ownerNodeId: "A", message: "x" },
      {
        status: "modal",
        ownerNodeId: "A",
        preview: { tag: "d" },
        pending: { kind: "OPENAPI", source: "s" },
      },
    ];
    for (const state of states) {
      it(`dismiss from ${state.status}`, () => {
        expect(specModalReducer(state, dismissModal())).toEqual({
          status: "closed",
        });
      });
    }
  });

  describe("wrong-state no-ops (state referentially unchanged)", () => {
    it("appliedFirstAttach while not applying is dropped", () => {
      expect(
        specModalReducer(previewingA, {
          type: "appliedFirstAttach",
          ownerNodeId: "A",
        }),
      ).toBe(previewingA);
    });

    it("appliedFirstAttach for a different owner is dropped", () => {
      const applyingA: SpecModalState<Preview> = {
        status: "applying",
        ownerNodeId: "A",
      };
      expect(
        specModalReducer(applyingA, {
          type: "appliedFirstAttach",
          ownerNodeId: "B",
        }),
      ).toBe(applyingA);
    });
  });
});
