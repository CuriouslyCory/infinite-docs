# 16. Passive nodes are a named Canvas taxonomy; the boundary-group container survives N=1

## Status

Accepted (Slice 4 of #14, the grouping follow-up on Slice 3's per-proxy
boundary-proxy rendering). Builds on
[ADR-0012](0012-routeflow-sole-cross-scope-edge-writer.md) (only **direct**
boundary proxies are routable at a given scope; **inherited** proxies are
context-only) and
[ADR-0004](0004-canvas-ssr-disabled-island.md) (the Canvas is a client-only
island whose React Flow store is seeded once per mount from
`useSuspenseQuery`).

## Context

Slice 3 introduced the per-proxy `boundary-proxy` Canvas node — a derived,
read-only stand-in rendered alongside interactive Components. Slice 4 folds
every *inherited* boundary proxy at a scope into one `boundary-group`
container so deep Canvases are not buried under N stand-ins for externals the
viewer cannot act on here. Direct proxies still render individually because
they are the **routable** surface (ADR-0012).

The implementation is render-layer only — no schema, mutation, service, or
derivation change — but it crystallizes two render-layer decisions that
neither slice's PR description nor any existing ADR captures. Both are the
kind of "judgment baked into a code comment" that ADR-0015 explicitly warns
against: the *why* lives only at the call site, so a future contributor
"simplifying" the code has no record of what it is buying.

1. **Is "passive node" a real taxonomy term or just a helper?** Slice 3 had
   one passive kind (`boundary-proxy`); the three interactive surfaces a
   Component participates in (the detail panel, Descent, hover-prefetch) each
   carried an inline `node.type === "boundary-proxy"` guard. Slice 4 adds a
   second passive kind (`boundary-group`), and a third (`boundary-port`,
   `boundary-route-summary`, …) is foreseeable. The slice consolidated the
   three guards into one `isPassiveNode` helper — but a helper is private to
   the file; a taxonomy is contractual. Without a recorded name, the next
   contributor inventing a fourth passive kind has no anchor to extend and
   will reach for a fresh inline guard.

2. **Does the boundary-group container wrap N=1, or render the lone
   inherited proxy directly?** Rendering directly is the obvious UX
   simplification — one stand-in needs no "1 inherited external" container
   around it. The slice wraps anyway. The justification ("a refetch flipping
   the inherited count never reshuffles the Canvas surface") sits in a code
   comment, but it is weak under today's seed-once model — ADR-0004 mounts
   the Canvas as a client island that seeds React Flow's `nodes` from
   `useSuspenseQuery` **exactly once per mount**; nothing reseeds the store
   when an in-page `getCanvas` cache invalidation lands, so the inherited
   count cannot *flip* mid-session at all. The decision is defensible only as
   forward-compat for if-and-when reseed-on-refetch is added. That subtlety
   belongs in an ADR, not buried in a comment a reader may discount.

## Decision

### `Passive node` is a Canvas taxonomy term, not a file-local helper

A **passive node** is a derived, read-only React Flow node on a Canvas that is
excluded from every interactive surface a Component participates in: the
**Component-detail panel** (no editable record exists), **Descent** (no
interior **Canvas scope** to open into), and hover-prefetch (nothing to
warm). The current members are `boundary-proxy` (per-proxy stand-in, Slice 3)
and `boundary-group` (the inherited-proxy container, Slice 4). Passive nodes
carry no `Node` row, are never `draggable`, `selectable`, or `deletable`,
and are recognized by a single discriminator — `isPassiveNode(node)` in
`canvas.tsx` — that the three interactive pointer handlers
(`onNodeClick`, `onNodeDoubleClick`, `onNodeMouseEnter`) call in identical
shape (`if (isPassiveNode(node)) return;`).

`isPassiveNode` takes `CanvasRFNode` (the discriminated union of the Canvas's
three node kinds), not `{ type?: string }`. The tighter type does three
things at once: (a) a stray non-Canvas node cannot be smuggled in as the
argument; (b) adding a fourth member to `CanvasRFNode` exposes
`isPassiveNode` to the exhaustiveness check, so a new passive kind cannot be
introduced without the helper acknowledging it; (c) it documents the
function's contract — *every* RF node on the Canvas runs through this
discriminator before the interactive paths execute, not just the ones the
caller happens to have on hand.

The term is recorded in CONTEXT.md under **Passive node**, and the
`Boundary group` and `Boundary proxy` entries cross-reference it. The name
is deliberately **passive** rather than "read-only" (which is overloaded
with the capability-URL viewer surface — owner-edit vs viewer-read) or
"non-interactive" (which over-claims — passive nodes still expand and
collapse their own internals; they are inert *with respect to the Canvas's
interactive surfaces*, not globally inert).

### The boundary-group container wraps even N=1

When `boundaryProxies.filter(p => p.origin === "inherited").length >= 1`,
the seed renders exactly one `boundary-group` container — never the lone
inherited proxy as a standalone node. N=0 renders nothing.

The single-member case keeps the container shape identical across **every
non-zero inherited-count transition**. With today's seed-once Canvas
(ADR-0004), the inherited count can only change between mounts, so the
guarantee is currently inert — there is no in-page refetch path that would
exercise it. But the seed-once model is not load-bearing here; if a future
slice adds an `invalidateQueries` → reseed bridge (e.g. cross-tab edit
sync, ancestor-scope mutation propagation, presence updates), the container
already absorbs an N=1 ↔ N=2 transition by swapping its member list rather
than by adding or removing a top-level React Flow node — preserving fitView
framing, selection state, and the user's expand toggle across the change.

The forward-compat framing is the entire justification. Rejected
alternatives:

- *Render the lone inherited proxy directly at N=1, switch to a container at
  N≥2.* The transition reshuffles the React Flow `nodes` array — the lone
  proxy disappears, a new container node appears at a different id —
  costing fitView framing and the user's expand toggle.
- *Decide the wrap threshold at render time from a config or feature flag.*
  Adds a knob with no current consumer; the threshold is a property of the
  semantics ("inherited proxies are context that gets bundled"), not a UX
  parameter.
- *Defer the decision until the reseed bridge actually lands.* Costs a
  second migration (every existing Canvas with one inherited external would
  re-render through a node-id change), and pushes the justification out of
  the slice that introduced the container.

## Consequences

- **`isPassiveNode` is the single extension point for new passive kinds.**
  A new passive node kind is added by (a) extending `CanvasRFNode`, (b)
  extending the disjunction in `isPassiveNode`, and (c) registering the type
  in `nodeTypes` — *not* by sprinkling a fresh inline guard through the
  pointer handlers. The pointer handlers stay closed against passive
  extensions.
- **Tightening the parameter to `CanvasRFNode` is the guard that keeps that
  contract honest.** A widened parameter type (`{ type?: string }`,
  `Node<any>`, etc.) silently re-opens the door to a "passive at this call
  site, interactive at that one" drift. A reviewer "simplifying" the
  parameter back to a structural type regresses this ADR.
- **The boundary-group container is structurally stable across
  inherited-count transitions.** A refactor that drops the N=1 wrap to
  render the lone proxy directly regresses this ADR, even though `pnpm
  check` and today's runtime will not surface the difference (the seed-once
  model masks the transition entirely). The reviewer signal is the
  comment-and-cross-reference at `canvas.tsx:toBoundaryGroupRFNode` plus the
  Boundary-group glossary entry.
- **The seed-once Canvas (ADR-0004) is no longer the only thing keeping the
  expand toggle stable across refetches.** Two defenses now stack: the seed
  prevents an in-page refetch from re-creating the container (ADR-0004),
  and — *if* the seed-once model is ever loosened — the N=1 wrap prevents
  the container from being created and destroyed as the inherited count
  crosses 1. A future ADR that lifts the seed-once model inherits this
  ADR's N=1 wrap; a future ADR that lifts the N=1 wrap must replace it with
  an equivalent stability guarantee on the reseed path.
- **No service, schema, or derivation change.** The partition runs
  client-side on `boundaryProxies[].origin`, a field
  `deriveBoundaryProxies` already returns (ADR-0012). A reviewer must keep
  the `origin` contract stable — changing it from `"direct" | "inherited"`
  to a richer shape requires this ADR's client partition to follow.
- **`pnpm check` sees the union exhaustion but not the rendered output.**
  The `CanvasRFNode` exhaustiveness check forces a new union member to be
  acknowledged in `isPassiveNode`; it cannot see that the wrap-at-N=1
  invariant is preserved. UI run-verification of expand/collapse, the
  three passive-node guards, and the N=0 / N=1 boundaries remains the
  human-in-the-loop check, gated on #23 (dev-auth owner session) like the
  rest of the boundary-proxy UI.

## Realized in #65 (per-edge model)

The passive-node code was removed with the dead Flow UI in #62 and re-introduced
in #65 in its **simpler per-edge form** (ADR-0031 retired the boundary-GROUP half
of this ADR — the container, the `origin: "direct" | "inherited"` partition, and
the N=1-wrap invariant — while keeping the passive-node taxonomy). #65 ships:
`CanvasRFNode = ComponentNode | BoundaryProxyNode`; `isPassiveNode(node:
CanvasRFNode)` returning true for the single `boundary-proxy` kind; and the three
interactive pointer handlers (`onNodeClick`, `onNodeDoubleClick`,
`onNodeMouseEnter`) each calling `if (isPassiveNode(node)) return;`. The
extension-point contract (a new passive kind = extend the union + the
discriminator + register the node type, never a fresh inline guard) is preserved;
the N=1 boundary-group wrap is **not** re-introduced (no container exists).
