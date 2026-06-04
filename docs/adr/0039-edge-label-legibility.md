# 39. Edge-label legibility: CSS-z-index layering, active-edge emphasis, picker-as-popover

## Status

Accepted.

Presentation-only. **Builds on** [ADR-0004](0004-canvas-ssr-disabled-island.md)
(the new `tooltip.tsx` primitive and the `INTERACTION_GLYPH` map are client-safe —
Base UI / `lucide-react` only — so the Canvas island bundle stays free of the
server graph), [ADR-0027](0027-connection-carries-its-own-interaction.md) (the
per-kind glyph is a presentation cue derived from `interaction`; it is **not** a
direction source, and the arrowhead remains derived solely from
`arrowEnds(interaction, source, target)`), and
[ADR-0031](0031-cross-scope-read-derivation-and-per-edge-boundary-proxy.md) (the
treatment renders through the single `ConnectionEdgeView`, so cross-scope,
altitude, and lineal/ingress edges resolved via `sourceRepr`/`targetRepr` get it
uniformly with no second code path). **Supersedes nothing.**

## Context

On a hub-dense Canvas — where many Connections converge on a few Components — edge
labels became unreadable. Six distinct failure modes compounded at the same spot:

- **Coincident paths (the worst):** several Connections between the *same* node
  pair — `A→B REQUEST` and `A→B PUSH` coexist by design (ADR-0010/0027), and #90
  routes many crossing edges to one coalesced boundary proxy — resolve to the same
  default handle, so React Flow draws them on one bezier path. Their labels stack
  at the *identical* point; if two are the same width the rear ones are entirely
  invisible, and the user has no signal they exist. A group of five Connections
  showed one label and hid four.
- **Overlap:** every label is pinned to its Edge's bezier midpoint with no
  collision avoidance, so converging Edges cluster their midpoints into one band.
- **Truncation:** a hard `max-w-[12rem] truncate` cut the label mid-word, eating
  the disambiguating tail (`…(SMART on FHIR)`, `…ITI-38 discovery`).
- **Z-order:** labels render as flat `position:absolute` siblings inside **one**
  shared `EdgeLabelRenderer` portal (a single stacking context) with no
  `z-index`, so whichever Edge rendered last won the stack arbitrarily.
- **Figure/ground:** the label's `#1f2138` background matched the node/canvas
  navy, so a label over a node read as node chrome.
- **Selection-pile:** the interaction picker mounted as an inline row *below the
  label at the same midpoint* — dropping a tall opaque control into the most
  crowded spot exactly when the user selected an Edge for clarity.

The decisive constraint is the z-order one: React Flow's edge `zIndex` /
`elevateEdgesOnSelect` act on the **SVG edge group**, not the label div, so they
cannot raise the active label. Plain CSS `z-index` on the rendered label div is
the only lever that works given the shared portal.

Structural fixes (semantic-zoom level-of-detail, label auto-offset along the
edge, full collision-avoidance layout) are deliberately **out of scope**; this
records the quick-win bundle only.

## Decision

### The active Edge reads loud; siblings recede

`active = hovered || isSelected`. The active label lifts (z-index 30 on hover, 40
on select), drops `truncate`, and shows its full text inline (`whitespace-normal
break-words max-w-[20rem]`) — no tooltip for the label itself, so the full text
appears exactly where the user is already looking. When some **other** Edge is
selected, resting labels recede (`opacity-40 blur-[1px]`); hover overrides recede
so pointing at a dimmed sibling lifts it back.

### Label layering is plain CSS z-index, never React Flow zIndex

A fixed flat scale on the rendered label div — resting `1`, hover `30`, selected
`40`, floating surfaces (tooltip / picker popover) `50` — kept on the same div
that carries the midpoint transform so no intermediate wrapper opens a new
stacking context.

### Connections sharing a path collapse into one on-demand group affordance

Edges are grouped by the unordered node pair they render between (`buildEdgeGroups`,
keyed by `edgePairKey`). A pair with **one** Connection renders exactly as before.
A pair with **N > 1** renders a single **group chip** at the shared midpoint — the
distinct interaction glyphs present plus the count — so "there are N here" reads at
a glance with nothing hidden. Clicking the chip opens a **Popover list** of every
Connection (a per-row direction glyph from `arrowEnds`, the interaction label, and
the full user label); clicking a row selects exactly that Connection
(`SelectEdgeContext`), surfacing its normal selected-edge label + picker — the
lone-edge flow, reused. Within a group: the focused (selected) member renders its
own UI; the deterministic primary (`members[0]`) renders the chip when none is
selected; the rest render no label layer. The Canvas builds the grouping once per
edges change (`useMemo`) and provides it via `EdgeGroupContext`. The chip stops its
own click/pointerdown from reaching the pane, or React Flow would select the
primary edge and tear the list down before it opens. The overlapping *lines* are
left merged — fanning the bezier paths apart is deferred with the other structural
work.

### The interaction picker is a Popover, off the midpoint

The picker moves out of the inline midpoint row into the canonical
`src/components/ui/popover.tsx` host (`side="bottom"`, collision-aware: it flips
above near the canvas edge, non-modal so the canvas stays pannable). It is
controlled by selection (`open = isSelected && canEdit`). The active interaction
button reads in the accent fill (`bg-[hsl(280,100%,70%)]/90 text-black`). The
text-edit `<input>` stays on the midpoint chip — only the picker leaves — so an
outside-press can never close the popover mid-edit.

### Per-interaction glyph + faint accent at rest; `INTERACTION_GLYPH` owns the map

Directional interactions (`REQUEST`/`PUSH`/`SUBSCRIBE`/`DUPLEX`) carry a small
`lucide-react` glyph and a faint left accent so a labelled or unlabelled Edge
reads at a glance; `ASSOCIATION` stays bare. An unlabelled directional Edge shows
a faint glyph dot at rest (the interaction's `INTERACTION_HINT` on hover); an
unlabelled `ASSOCIATION` shows nothing. The map is `INTERACTION_GLYPH` in
`~/lib/interactions.ts`, `Record<Interaction, LucideIcon | null>`, sibling to
`INTERACTION_LABEL`/`INTERACTION_HINT` — the same `KIND_ICON` pairing
`~/lib/node-kinds.ts` already relies on.

### Sibling-recede keys off a boolean store selector

`useStore(s => s.edges.some(e => e.selected))` — a boolean ("is any Edge
selected"), not the selected id, so it flips false↔true once per selection change
and each Edge re-renders on the transition, not per pixel. v1 dims on **selection
only** (hover stays edge-local). The selector is O(N) per store notification per
subscribed Edge; negligible at target sizes. If a large-graph regression ever
appears, hoist the boolean to one `useStore` call in the Canvas island and pass
it via context.

## Consequences

- **Reviewable invariant:** Connections that render on the same path (same node
  pair) never stack their labels — they collapse into one group chip (count +
  distinct glyphs) whose list is the only place the individual labels render, and
  selecting a row reuses the lone-edge selected view. A change that renders each
  member's label at the shared midpoint regresses this ADR (it reinstates the
  invisible-rear-label bug). Grouping is by unordered node pair; the primary is
  `members[0]` after the deterministic interaction-then-id sort.
- **Reviewable invariant:** active-edge label layering uses plain CSS `z-index` on
  the `EdgeLabelRenderer` div (resting `1` / hover `30` / selected `40` / floating
  surfaces `50`). Raising a label via React Flow's edge `zIndex` /
  `elevateEdgesOnSelect`, or by reordering the edges array, regresses this ADR
  (those raise the SVG group, not the label).
- **Reviewable invariant:** the interaction picker and the `+ label` affordance
  mount only through `src/components/ui/popover.tsx`; the picker never renders
  inline at the bezier midpoint. The text-edit `<input>` stays on the chip.
- **Reviewable invariant:** `INTERACTION_GLYPH` is keyed `Record<Interaction, …>`
  with `ASSOCIATION → null` by design; a new `Interaction` value fails to compile
  until it gets a glyph. The glyph is an interaction-**kind** cue, never a
  direction signal — the only rendered direction stays the arrowhead derived from
  `arrowEnds` (ADR-0027); the glyph must not vary with `(source, target)` draw
  order.
- **Reviewable invariant:** sibling-recede is driven by a boolean store selector
  (flip-only fan-out), not a per-edge id or per-pixel signal.
- Presentation-only: no schema, tRPC, service, or data-model change; `arrowEnds`
  and `toRFEdge` are untouched. Tooltip content reuses `INTERACTION_HINT` (no new
  strings); the picker stays labelled "Interaction", never "type" (CONTEXT.md).
- The read-only **Trace view** keeps its own simpler edge component
  (`src/app/p/[slug]/_trace/trace-edge.tsx`, registered as `trace-connection`),
  which deliberately does **not** reuse `ConnectionEdgeView` — it exposes none of
  the label/interaction editing contexts. The two diverge on purpose; this is not
  an inconsistency to "fix" by merging them.
- A new client-only `tooltip.tsx` primitive joins `popover.tsx` / `dialog.tsx` /
  `command.tsx` as a thin Base UI wrapper. Its panel is `pointer-events: none`
  (never intercepts a canvas pan) and it imports only Base UI + React (ADR-0004).
