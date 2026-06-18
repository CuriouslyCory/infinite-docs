# 47. The Spec preview/apply modal as one pure `SpecModalState` machine — the preview-clobber race made unrepresentable

## Status

Accepted (#146).

**Builds on** [ADR-0046](0046-optimistic-write-seam.md): that ADR established the
pattern this one reuses — a pure, framework-free, generic-over-its-payload module
that ships inside the Canvas client island (no `RouterOutputs`, no server graph
across the `verbatimModuleSyntax` boundary of [ADR-0004](0004-canvas-ssr-disabled-island.md)),
with all side effects kept caller-side. `optimistic-write.ts` is the structural
template for `spec-modal-state.ts`.

**Relates to** [ADR-0029](0029-specs-generate-components-recursive-parse-diff-merge.md):
this ADR models the lifecycle that ADR defines (preview → first-attach convenience
path or merge modal → apply) as an explicit state machine. It **amends neither**
ADR-0029 nor [ADR-0025](0025-flowspec-parser-registry-and-spec-kind-affinity.md) — no parse, diff,
classification, or apply behavior changes; the convenience first-attach path is
preserved exactly. This slice is purely a state-shape refactor.

## Context

The Spec preview/apply flow in `canvas.tsx` was driven by four interdependent
`useState` fields: `activePreviewOwnerId` (the in-flight preview's owner, doubling
as the panel spinner flag), `specPreviewError` (`{ ownerNodeId, message }`),
`pendingPreview` (`{ ownerNodeId, kind, source }` — the pasted source the modal's
confirm re-applies), and `specPreview` (the diff classification the modal renders).

Their Cartesian product admits states the flow never intends: a staged `specPreview`
with no `pendingPreview` source (a modal that cannot confirm), or `pendingPreview`
set with `specPreview` null. Worse, each field carried its own ad-hoc owner scoping
because the panel renders for whatever node is **currently selected** — a preview
started on node A that resolves after the user has clicked node B must not leak A's
spinner, error, or modal into B's panel. That owner-guard was re-derived at each
read site (`activePreviewOwnerId === selectedNodeId`, `specPreviewError?.ownerNodeId
=== selectedNodeId`) and, critically, at each **write** site in the async
`onSuccess`/`onError` callbacks — the place a late, stale result actually lands. A
missed guard there is a real clobber race.

## Decision

### One discriminated union owns the lifecycle

`spec-modal-state.ts` exports a pure `SpecModalState<P>` (generic over the preview
type `P`, so it imports no `RouterOutputs`) with five states:

- `{ closed }`
- `{ previewing; ownerNodeId }` — preview mutation in flight (panel spinner)
- `{ applying; ownerNodeId }` — first-attach's **no-modal** apply in flight (panel
  spinner persists through it)
- `{ error; ownerNodeId; message }`
- `{ modal; ownerNodeId; preview: P; pending: { kind; source } }` — the merge modal

A pure `specModalReducer<P>(state, action)` drives it via four caller intents:
`open` (→ `previewing`, superseding any prior preview/error), `resolve`
(error → `error`, firstAttach → `applying`, modal → `modal`), `appliedFirstAttach`
(→ `closed` once the no-modal apply settles), and `dismiss` (→ `closed`). Thin
`openPreview`/`dismissModal` action creators exist for ergonomics.

`canvas.tsx` holds it with a single `useReducer`; `dispatchSpecModal` is
referentially stable, so it never expands a `useCallback` dependency array.

### The seam boundary (builds on ADR-0046)

The reducer is **PURE** — no tRPC, toast, `reseedCrossScope`, or `invalidate`. Every
side effect stays caller-side in the handlers, byte-identical to before: the
handlers dispatch transitions and run their effects. In particular the first-attach
`invalidate().then(reseedCrossScope)` ordering and the apply-modal reseed are
untouched; the machine only flips status. This is the same pure-core /
caller-owned-effects split ADR-0046 drew.

### The owner-guard lives in `resolve`

`resolve` acts **only** while the machine is still `previewing` the same
`ownerNodeId` the result is for; any other state (or a different owner) returns the
state **referentially unchanged**, dropping the stale result. The async callbacks
no longer re-implement the guard — they dispatch unconditionally and the reducer
arbitrates.

## Consequences

- **Reviewable invariant (headline):** the preview-clobber race is **unrepresentable
  by construction** — `resolve`'s owner-guard is the single place a late result is
  admitted or dropped, so a preview for A resolving after the user moved to B
  cannot open a modal, set an error, or spin B's panel. A change that lets `resolve`
  act outside `previewing`, or for a non-matching owner, regresses this ADR. The
  unit test asserts the dropped result returns the state **referentially** unchanged
  (`toBe`), for the error, modal, and firstAttach variants.
- **Reviewable invariant (bijection):** each old four-field combination maps to
  exactly one union state, and the two representable-but-invalid combinations
  (`preview`/`pending` desync) are removed with **none newly allowed**. No live
  behavior is lost or gained.
- **Reviewable invariant (convenience path):** first-attach transitions
  `previewing → applying → closed`, **never through `modal`** — preserving both the
  ADR-0029 no-modal convenience apply and the panel spinner during it. `applying`
  exists solely to keep that spinner; folding it away would regress the spinner.
- `applySpec.isPending` still drives the modal footer's `pending` prop and is **not**
  folded into the union — the union models which surface is showing, not the apply
  mutation's in-flight bit. `spec-conflict-modal.tsx` is unchanged.
- The reducer's correctness rests on **direct unit tests** (ADR-0003, node env,
  no React): open/resolve/dismiss/appliedFirstAttach transitions, the
  wrong-state no-ops, and the stale-result drop race for all three resolve variants.
