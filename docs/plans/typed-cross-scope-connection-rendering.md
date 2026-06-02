# Plan — #65 Canvas: render typed cross-scope connections + far-end proxies

## Goal

Make the Canvas render what `getCanvas` already returns (from #63 / ADR-0031): typed
Connections with interaction-derived arrowheads, and the off-scope end of each
cross-scope Connection as a read-only **boundary proxy** stand-in with a "go to the real
endpoint" affordance. Plus a per-Connection **interaction picker** to upgrade a freshly
drawn `ASSOCIATION` to a directional type, preserving drawn direction. This is the
client-render slice on top of #63's data; the only backend addition is a narrow
interaction-edit mutation.

## The vertical slice

One pure helper + one new passive node component + one new edit mutation, wired into the
existing optimistic Canvas model. Concretely: draw a same-Canvas Connection (plain line),
select it, cycle its interaction and watch arrowheads flip live; descend into a child and
see the parent render as a clearly-labelled inbound (ingress) boundary proxy; click "go to
real" and land in the far node's scope. Viewers see arrowheads + proxies but no picker.

## Key facts established during research

- `getCanvas` already returns `interiorEdges` with `sourceRepr`/`targetRepr` and a
  `boundaryProxies[]` (`{nodeId,title,kind,realEndpointId,edgeId}`, synthetic
  `nodeId = proxy_<edgeId>`) — `node.service.ts:210-549`. The Canvas **ignores all three
  today**: `toRFEdge` maps `e.sourceId`/`e.targetId` directly and `boundaryProxies` is
  destructured out unused (`canvas.tsx:97-110`, `:226`).
- The optimistic helpers already populate reprs (`sourceRepr===sourceId`) and
  `interaction: "ASSOCIATION"` (`canvas.tsx:145-183`), so the same-Canvas optimistic path
  needs **no shape change** — only `toRFEdge` changes.
- `updateEdgeInput`/`updateEdge` accept **only `label`** today; both docstrings explicitly
  say interaction is "edited via its own surface (#65), not here" (`schemas.ts:392-394`,
  `edge.service.ts:166-167`).
- `interaction` is in the **directional de-dupe key** (ADR-0010/0027), so an interaction
  *edit* can collide → must return `ConflictError` (a label edit never can).
- The passive-node taxonomy (`isPassiveNode`/`CanvasRFNode`, ADR-0016) was removed with the
  dead Flow UI in #62; ADR-0031 says it "survives unchanged" as the extension point. #65
  re-introduces it in its **simpler per-edge form** — one `boundary-proxy` kind, no
  `boundary-group`, no `origin`.
- No `connection-direction`/`flow-direction` helper exists; #65 creates it (ADR-0027:61
  blesses the name as the `flow-direction` successor).

## Reconciled decisions (where specialists differed)

1. **Interaction-edit surface → a SEPARATE `updateEdgeInteraction` mutation**, not an
   optional field on `updateEdge`. Rationale: (a) the codebase's established grain is
   granular single-concern mutations (`updateNode`/`updateNodeKind`/`updateNodeDocumentation`
   each own one field); (b) the two operations have **different collision semantics** —
   label edits can never collide, interaction edits can (`ConflictError`) — so folding them
   leaves `updateEdge` with two code paths; (c) both existing docstrings literally say
   interaction is edited "via its own surface … not here," signalling a separate surface was
   the design intent. Keeps `updateEdge` trivially label-only and puts all de-dupe logic in
   one place that mirrors `connectNodes`. *(The Architect favored extending `updateEdge`;
   decided against for the collision-separation reason above.)*

2. **Descend-to-real → Option A: `router.push(/p/[slug]/n/[realEndpointId])`** (the far
   node's own interior scope). Unanimous across specialists. Needs **no server change** and
   respects ADR-0031's frozen 5-field proxy shape. "A node id IS a scope" is the codebase's
   established meaning (`getCanvas` scope semantics; the `/n/[nodeId]` route). Option B
   (route to the canvas *containing* the real node so it renders as a real node) would need
   the far node's `parentId` on the proxy row — an ADR-0031 violation and #63's surface, not
   #65's. Reuse the existing `descend` callback.

3. **Helper stays framework-agnostic.** `~/lib/connection-direction.ts` imports only
   `type Interaction` from `~/lib/schemas` (mirrors `connection-rules.ts`) and **must not**
   import `@xyflow/react` (`MarkerType` is a runtime enum → ADR-0004 bundle leak). Export
   `arrowEnds(interaction): { atSource: boolean; atTarget: boolean }` — the pure core. The
   Canvas maps `atSource/atTarget` → React Flow `markerStart`/`markerEnd`
   (`MarkerType.ArrowClosed`) inside `toRFEdge`; #67's exporter maps the same booleans → the
   `→`/`←`/`↔`/`—` glyph. The helper takes only `interaction` — which physical end the arrow
   lands on is bound by React Flow via the edge's stored `source`/`target` (markerStart =
   source end), so draw order is honored without passing it in. Exhaustive over the enum
   (a sixth value fails to compile). Colocate `connection-direction.test.ts`.

   Mapping (ADR-0027:64-67): `REQUEST`/`PUSH` → arrow at target; `SUBSCRIBE` → arrow at
   source; `DUPLEX` → both; `ASSOCIATION` → neither.

## Ordered steps

### 1. `src/lib/connection-direction.ts` (new) — the pure helper
Mirror `connection-rules.ts`'s header (imports nothing but `type Interaction`). Export
`arrowEnds(interaction): { atSource, atTarget }` with an exhaustive switch. Cite ADR-0027.
Add `connection-direction.test.ts` covering all five values (the repurposed ADR-0023 arrow
matrix, ADR-0027:96-97).

### 2. `src/lib/interactions.ts` (new) — user-facing labels
A `Record<Interaction, string>` `INTERACTION_LABEL` (parallel to `KIND_LABEL` in
`node-kinds.ts:51-78`, same compile-time-exhaustiveness guard), client-safe (imports only
`~/lib/schemas`). Labels: `ASSOCIATION`→"Association", `REQUEST`→"Request / response",
`PUSH`→"Push", `SUBSCRIBE`→"Subscribe", `DUPLEX`→"Duplex". (Optional `INTERACTION_HINT` for
picker sublabels.)

### 3. `src/lib/schemas.ts` — interaction-edit input
Add `updateEdgeInteractionInput = z.object({ id, interaction })` (required interaction —
narrow). Keep `updateEdgeInput` label-only; update its docstring to name the real surface
(`updateEdgeInteraction`) instead of "(#65)".

### 4. `src/server/architecture/edge.service.ts` — `updateEdgeInteraction`
New service fn mirroring `updateEdge`'s load+authz (`assertCanWrite`, ADR-0001) and
`connectNodes`' de-dupe pattern: load the active Edge → `assertCanWrite` → if the new
interaction differs, run `activeDuplicateWhere(projectId, edge.sourceId, edge.targetId,
newInteraction)` **merged with `id: { not: edge.id }`** (an edge is not its own duplicate —
the one genuinely new line vs. `connectNodes`) → `ConflictError` on a hit; then
`db.edge.update` wrapped in the `isEdgeDedupCollision` P2002 backstop → re-read racer →
`ConflictError` (verbatim `connectNodes:127-149`). **Source/target are never rewritten** —
upgrading preserves stored draw order, so the arrow points the way it was drawn (ADR-0027:50-57).

### 5. `src/server/api/routers/architecture.ts` — procedure
Register `updateEdgeInteraction: protectedProcedure.input(updateEdgeInteractionInput)` →
`updateEdgeInteraction(ctx.db, actor, input)`, mapping errors via the existing `toTRPCError`
(mirror the `updateEdge` procedure at `:206-215`).

### 6. `src/app/p/[slug]/_canvas/boundary-proxy.tsx` (new) — passive proxy node
`BoundaryProxyNodeView`: kind icon (`KIND_ICON`) + title + both handles (so the edge
attaches either side) + a "go to real" button. Inert — no rename/delete/select chrome.
Consumes `DescendComponentContext` and calls `descend(realEndpointId)`. **Lineal/ingress
labelling**: the seed computes a `lineal` flag (proxy's `realEndpointId` ∈ breadcrumb ids —
see step 7) passed in `data`; when lineal, render the inbound-boundary treatment with copy
**"Inbound connection from {title}"** (aria-label: `Inbound connection from {title} ({kind})
— boundary proxy, read-only`) instead of the bare title, defusing the "host inside itself"
misread (ADR-0031:80-96). Affordance copy is **"Go to {title}"** — *not* "Descend"/"Open":
Descent has a strict glossary meaning (interior entry, deeper) that this lateral/upward nav
violates.

### 7. `src/app/p/[slug]/_canvas/canvas.tsx` — the bulk
- **`toRFEdge`** (`:97-110`): map `source: e.sourceRepr`, `target: e.targetRepr` (NOT the raw
  endpoint ids); derive `arrowEnds(e.interaction)` → set `markerStart`/`markerEnd` with
  `MarkerType.ArrowClosed`; carry `interaction` in `data`. **All marker logic lives here,
  fed by the helper** — never inline in the edge component (ADR-0027 reviewable invariant).
- **`toProxyRFNode`** (new) + `CanvasRFNode = ComponentNode | BoundaryProxyNode` union +
  `isPassiveNode(node: CanvasRFNode)` (true for `boundary-proxy`). Type the React Flow
  element `ReactFlow<CanvasRFNode, ConnectionEdge>` (`:1034`) for exhaustiveness. Add
  `"boundary-proxy"` to `nodeTypes` (`:78`). Add a code-comment cross-ref to ADR-0016 at
  `isPassiveNode` (the reviewer signal).
- **Seed proxies into `nodes`** (`:240`): `[...interiorNodes.map(toRFNode),
  ...boundaryProxies.map(toProxyRFNode)]`, each `draggable:false, selectable:false,
  deletable:false`. Compute the breadcrumb-id `Set` once for the `lineal` flag.
- **Guard the three pointer handlers** (`onNodeClick:1064`, `onNodeDoubleClick:1073`,
  `onNodeMouseEnter:1074`): leading `if (isPassiveNode(node)) return;` (ADR-0016).
- **Fix the incident-edge filters** in `removeComponent` (`:913-914`) and
  `undoRemoveComponent` (`:711-722`): they currently match RF `e.source`/`e.target`, which
  after the repr swap become `proxy_<edgeId>` for cross-scope edges → the store filter would
  miss them. Derive incident-ness from the cached canvas edge's real `sourceId`/`targetId`
  (the cache-mirror filter at `:917-918` already does — make the store filter match it).
  **`pnpm check` cannot see this; it must be dev-browser tested.**
- **`commitEdgeInteraction`** (new, mirror `commitEdgeEdit:976-1002`): optimistic
  `setEdges` routed through `toRFEdge` so `data.interaction` **and** the top-level markers
  update live this frame (`BaseEdge` reads markers off the edge object, not `data`) +
  `patchCanvas` interiorEdges; one `updateEdgeInteraction` mutation; **conditional** rollback
  (mirror `commitRename:382-403` so a newer change isn't clobbered) + a **conflict-aware
  toast** (distinguish `CONFLICT` → "That connection type already exists between these
  components" from generic failure, like `messageForDocsSaveFailure:193-202`).
- Route the optimistic edge in `handleConnect` (`:616-627`) through
  `toRFEdge(optimisticCanvasEdge(...))` for marker/interaction consistency.
- Provide a new `SetEdgeInteractionContext` in the provider stack (`:1029-1033`).

### 8. `src/app/p/[slug]/_canvas/connection-edge.tsx` — interaction picker
Add `interaction: Interaction` to `ConnectionEdgeData` (`:14-19`). Add
`SetEdgeInteractionContext` (a `(id, interaction) => void`, default inert) parallel to
`EditEdgeContext` (`:30-32`). In the label-renderer block (`:118-177`), when
`isSelected && canEdit`, render a 5-option interaction picker (driven by `INTERACTION_LABEL`)
alongside the existing `+ label`/label editor. The picker label says **"Interaction"** —
never "type" (glossary: React Flow's `type` is the registry key; `interaction` is never
"type"). Arrowhead passthrough already works (`:113-116`); no marker logic here.

### 9. Docs that travel with the slice
- **CONTEXT.md** tense flips (forward-ref → realized, no meaning change): **Connection**
  (delete "until then … plain lines"), **Edge**, **Interaction** (delete "until then …
  plain line"), **Boundary proxy** (add the "go to real endpoint" affordance), **Passive
  node**, **Canvas**, **getCanvas**. Add a one-line `INTERACTION_LABEL` mention to the
  Interaction entry (mirroring how Component kind names `KIND_LABEL`).
- **ADR-0027**: one-line "Realized in #65 (`~/lib/connection-direction.ts`)" under
  Consequences **plus a short amendment** recording interaction-*edit* semantics
  (editable post-creation via `updateEdgeInteraction`; preserves draw order; re-evaluates
  the de-dupe key; `ConflictError` on collision) — the one behavior existing ADRs don't
  cover. **ADR-0031 / ADR-0016**: one-line "Realized in #65" status notes; no amendment.
- **In-passing stale-comment fixes** (files already being edited): the ADR-0023 citation in
  the Port handle comments (`component-node.tsx:128-133`) → ADR-0027; the boundary-group
  reference in the `KIND_LABEL` header (`node-kinds.ts:49-50`) → boundary-proxy; the
  `connection-rules.ts` header note (`:19-26`) → the interaction arm is a **#66** (draw-with-
  type) need, not #65 (the picker is an *edit*, not a draw).

### 10. Validate
`pnpm check`, then **dev-browser** (logged-in Chromium): draw a same-Canvas Connection
(plain line, no flicker on reconcile); select it, cycle all 5 interactions watching
arrowheads flip live; force a de-dupe conflict (upgrade to a directional that already
exists) and confirm the conflict toast + rollback; descend into a child and confirm the
parent renders as a labelled **inbound** proxy (not "host inside itself"); click "go to
real" and land in the far node's scope; **delete a component that is the near end of a
cross-scope edge** and confirm its proxy edge disappears (the repr-swap filter fix); confirm
a viewer (canEdit=false) sees arrowheads + proxies but no picker.

## Risks + mitigations

| Risk | Mitigation |
| --- | --- |
| **Repr swap silently breaks the incident-edge store filter** in `removeComponent`/`undoRemoveComponent` (now match reprs, not real ids). `pnpm check` can't see it. | Filter the store on the cached edge's real `sourceId`/`targetId` (step 7). Dev-browser test: delete a near-end component of a cross-scope edge. |
| Live arrowhead fails if only `data.interaction` is patched (`BaseEdge` reads markers off the edge object). | Optimistic `setEdges` routes through `toRFEdge` so markers + data move together (step 7). |
| Interaction upgrade hits a server de-dupe `ConflictError`. | `updateEdgeInteraction` mirrors `connectNodes`' de-dupe with `id:{not}`; client does conditional rollback + conflict-aware toast (steps 4, 7). |
| `@xyflow/react` leaking into `~/lib` via the helper. | Helper returns framework-agnostic booleans; `MarkerType` mapping stays in the island; ESLint ADR-0004 guard backs it (step 1). |
| Cross-scope edges silently vanish if proxies aren't seeded (RF drops edges with no endpoint node). | Seed **all** `boundaryProxies` as nodes before edges; dev-browser-verify cross-scope edges render (steps 7, 10). |
| Multiple proxies for one far node clutter the canvas. | Per-edge rendering is ADR-0031-sanctioned (visual coalescing is an explicit later client choice); ship per-edge, note as follow-up. |
| Picker crowds the edge midpoint where the label editor already lives. | Inline picker near the label affordance; exact form (segmented control vs popover) settled in dev-browser. Open question below. |

## Assumptions & open questions

- **Assumption (verified):** lineal/ingress ⟺ `proxy.realEndpointId ∈ breadcrumb ids` —
  covers both the ancestor case and the "far end is the scope itself" parent→child case
  (both are the "host inside itself" situation); a different-subtree proxy is correctly not
  flagged. No server data needed.
- **Assumption (verified):** `canConnect` needs **no** interaction arm in #65 — #65 only
  *draws* `ASSOCIATION`s and *edits* interaction via `updateEdgeInteraction` (not through
  `canConnect`). The arm is a **#66** dependency (the draw-with-type "Connect to…" gesture).
- **Open (UX, settle in dev-browser):** picker form (inline 5-glyph segmented control vs.
  small popover); the "go to real" verb for ingress (ancestor) proxies ("Go to {title}").
- **Open (forward-compat):** whether #67 wants the `{atSource,atTarget}` boolean contract or
  a richer discriminant for glyph derivation — boolean pair trivially yields both markers and
  glyph; align with #67 to avoid a later refactor.

## Explicitly OUT OF SCOPE (sibling seams)

- **#66** — the project-wide "Connect to…" search gesture and the Connections section in the
  Component-detail panel. #65's only draw path is the existing same-Canvas port-drag.
- **#67** — the markdown export rewrite (interaction glyph serialization, golden re-baseline)
  and the MCP surface. #65 **creates** the shared `connection-direction` helper but does
  **not** wire it into `export.service.ts`/`markdown.ts`, change export output, or touch MCP /
  `apply_graph` interaction.
- **#63 (merged)** — the `getCanvas` derivation and the `boundaryProxies`/repr data shape
  (ADR-0031, frozen 5-field proxy row). #65 consumes it; it does not change the SQL or the
  proxy shape (which is why descend-to-real uses Option A).
