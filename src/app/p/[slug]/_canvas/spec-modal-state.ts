import { type SpecKind } from "~/lib/schemas";

/**
 * The Spec preview/apply modal as ONE pure state machine, generic over the
 * preview type `P` so the core imports NO `RouterOutputs` and ships inside the
 * Canvas client island without dragging the server graph across the
 * `verbatimModuleSyntax` boundary (the caller threads the concrete preview type)
 * — same posture as `optimistic-write.ts` (ADR-0046), which is the structural
 * template here.
 *
 * The five states replace four interdependent `useState` fields whose product
 * could represent invalid combinations (a staged `preview` with no `pending`
 * source, or vice-versa). Each state below carries exactly the fields that state
 * needs, so those desyncs are no longer representable.
 *
 * The headline invariant lives in `resolve`'s **owner-guard**: a `resolve` only
 * acts while the machine is still `previewing` the SAME `ownerNodeId` that the
 * result is for; a result for any other owner (the user moved on to another
 * node) returns the state REFERENTIALLY UNCHANGED. This makes the preview-clobber
 * race — a late preview for A leaking its modal/error/spinner into B's panel —
 * unrepresentable by construction rather than by a scattered set of guards.
 *
 * The reducer is PURE: no tRPC, toast, reseed, or any side effect. The caller
 * keeps all of those and merely dispatches transitions (ADR-0046's pure-core /
 * caller-owned-effects boundary).
 */
export type SpecModalState<P> =
  | { status: "closed" }
  | { status: "previewing"; ownerNodeId: string }
  // firstAttach's no-modal apply in flight — preserves the panel spinner during
  // the convenience path (previewing → applying → closed, never through modal).
  | { status: "applying"; ownerNodeId: string }
  | { status: "error"; ownerNodeId: string; message: string }
  | {
      status: "modal";
      ownerNodeId: string;
      preview: P;
      pending: { kind: SpecKind; source: string };
    };

export type SpecModalAction<P> =
  | { type: "open"; ownerNodeId: string }
  | {
      type: "resolve";
      ownerNodeId: string;
      result:
        | { kind: "error"; message: string }
        | { kind: "firstAttach" }
        | {
            kind: "modal";
            preview: P;
            pending: { kind: SpecKind; source: string };
          };
    }
  | { type: "appliedFirstAttach"; ownerNodeId: string }
  | { type: "dismiss" };

export function specModalReducer<P>(
  state: SpecModalState<P>,
  action: SpecModalAction<P>,
): SpecModalState<P> {
  switch (action.type) {
    case "open":
      return { status: "previewing", ownerNodeId: action.ownerNodeId };
    case "resolve": {
      // Owner-guard: drop a result that arrived after the user moved on (or
      // after dismiss). Returning `state` unchanged is what closes the race.
      if (
        state.status !== "previewing" ||
        state.ownerNodeId !== action.ownerNodeId
      ) {
        return state;
      }
      const { result } = action;
      switch (result.kind) {
        case "error":
          return {
            status: "error",
            ownerNodeId: action.ownerNodeId,
            message: result.message,
          };
        case "firstAttach":
          return { status: "applying", ownerNodeId: action.ownerNodeId };
        case "modal":
          return {
            status: "modal",
            ownerNodeId: action.ownerNodeId,
            preview: result.preview,
            pending: result.pending,
          };
      }
    }
    case "appliedFirstAttach":
      if (
        state.status === "applying" &&
        state.ownerNodeId === action.ownerNodeId
      ) {
        return { status: "closed" };
      }
      return state;
    case "dismiss":
      return { status: "closed" };
  }
}

export function openPreview<P = never>(
  ownerNodeId: string,
): SpecModalAction<P> {
  return { type: "open", ownerNodeId };
}

export function dismissModal<P = never>(): SpecModalAction<P> {
  return { type: "dismiss" };
}
