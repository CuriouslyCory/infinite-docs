# 15. Component docs edit + render via one Plate WYSIWYG editor over a markdown string, debounced-optimistic autosave

## Status

Accepted.

## Context

Every Component carries a `Node.documentation` string (markdown), but nothing
let a user edit it (`updateNode` was title-only) or read it formatted. Two
issues cover the gap: #11 (edit, debounced optimistic autosave, no save button)
and #12 (render formatted markdown, toggle between editing and a rendered view).
The issue thread fixed the editor technology: **Platejs**.

The decision worth recording is that **one Plate integration satisfies both
issues**. Plate is a WYSIWYG editor: its `readOnly` mode renders the same
content formatted, which _is_ #12's rendered view — so a separate markdown
renderer is unnecessary, and there is one surface, not two that can drift.

This rides the "docs travel with code slices" convention: the ADR justifying a
new heavy client dependency and the markdown-round-trip storage contract ships
with the slice that introduces them.

## Decision

1. **Markdown string stays the source of truth; Plate is a bridge, not the
   store.** `Node.documentation` remains a markdown `String` (no schema
   change). The editor deserializes it on mount
   (`editor.api.markdown.deserialize`) and serializes back
   (`editor.api.markdown.serialize`, `@platejs/markdown` + `remark-gfm`) on each
   debounced save. Markdown — not a Slate JSON blob — is what the deterministic
   graph export (#15) and MCP resources will consume, so it is what we persist.

2. **One editor, two modes.** `readOnly` Plate is the rendered view (#12);
   flipping it editable is edit mode (#11). Default is **view-first**. A
   read-only viewer surface (capability-slug visitors) is out of scope here —
   the detail panel stays owner-gated; viewer rendering is a later slice tied to
   capability-URL sharing (#16).

3. **A dedicated narrow mutation, `updateNodeDocumentation(db, actor, {id,
documentation})`,** not an optional field on `updateNode`. Same
   load-then-authorize shape and owner-only `access.assertCanWrite` as
   `updateNode` (ADR-0001). Keeps the autosave payload to `{id, markdown}` and
   leaves rename's required-`title` contract intact — the codebase's
   granular-mutation convention (`updateNode` / `updatePositions`). The empty
   string is valid (clears the docs). `documentation` is UNTRUSTED, stored
   verbatim (prompt-injection standing note).

4. **Autosave is debounced and optimistic; the mutation lives on the canvas,
   not the editor.** No save button. On a ~700ms idle the editor serializes and
   calls `onCommit`, which the canvas implements as `commitDocumentation` —
   mirroring `commitRename`: optimistic patch of the `getCanvas` query-cache
   mirror, fire-and-forget mutation, snapshot rollback + toast on failure. The
   mutation hook living on the canvas (not inside the editor) is what lets the
   editor unmount the instant the user deselects without aborting the in-flight
   write. The editor additionally **flushes any pending edit on blur, on
   switching back to view, and in its unmount cleanup** — the no-lost-work
   guarantee.

5. **Bounded markdown feature set; round-trip is lossy outside it.** Supported:
   paragraphs, headings, bold/italic/strikethrough/inline-code, bulleted /
   numbered lists, links, blockquote (basic-nodes + `@platejs/list` +
   `@platejs/link`). Constructs outside this set (tables, images, footnotes,
   raw HTML) degrade on save. This is acceptable because **a Component's docs
   start empty and are authored in this editor** — there is no legacy markdown
   to lose. Widening the set is additive (add the plugin + a style rule).

6. **Lazy-loaded with hover-warm; no shadcn cascade.** The editor is
   `next/dynamic`-imported in the detail panel so the Plate bundle code-splits
   and only downloads on first Component selection (it never weighs down the
   canvas island's initial load). To avoid every owner paying a "Loading
   editor…" flash on their first click, the canvas hover handler (`onNodeMouseEnter`)
   also calls `prefetchDocsEditor()` — a module-scope memoized `import()` of the
   chunk — so by the time the user actually clicks the Component, the chunk is
   parsed and ready. Same pattern as the existing `getCanvas` / `router.prefetch`
   hover-warming. It is hand-styled with Tailwind + a scoped `.plate-doc` rule
   in `globals.css` (Tailwind preflight strips heading/list styling), **not**
   the Plate UI kit — that would pull radix / cva / clsx / tailwind-merge and
   dozens of vendored components this repo deliberately does not use.

7. **Editor contract for hosting inside the canvas event surface.** Mounting an
   editable surface inside a React Flow `<Panel>` means several invisible
   contracts: every interactive element carries `.nodrag` (the toolbar wrapper
   and `PlateContent`) so a drag inside the editor doesn't pan the canvas, and
   the section root stops Backspace / Delete propagation so React Flow's
   `deleteKeyCode` handler can't sweep the selected Component while the user is
   editing. These are part of the editor contract, not incidental styling.

## Alternatives considered

- **Store a Slate JSON value instead of markdown.** Rejected: the export (#15)
  and MCP resources need markdown; storing JSON would force a serialize step at
  every read boundary and make the stored shape Plate-version-coupled.
- **Extend `updateNode` with an optional `documentation` field.** Rejected:
  weakens rename's required-`title` contract and fattens every autosave payload;
  the granular-mutation convention is cleaner ("prefer narrow required inputs").
- **A separate read-only markdown renderer for #12 (e.g. react-markdown).**
  Rejected: a second rendering path that can drift from what the editor shows;
  `readOnly` Plate is the same renderer, guaranteed consistent.
- **Plate UI kit (shadcn).** Rejected for scope/dependency weight; a minimal
  hand-styled toolbar covers the supported feature set.
- **Click / focus the rendered surface to edit (no explicit toggle).** Rejected:
  view-first with an explicit Edit affordance is a clearer state signal in a
  mixed read/write detail panel, and the dashed empty-state CTA already gives a
  one-click path for empty docs. Focus-to-edit would also conflict with the
  rendered-only path planned for the capability-URL viewer (#16) — same surface
  for both audiences keeps the implementation single-rooted.
- **Render docs to capability-slug viewers now.** Deferred: the panel holds
  owner-only tools and gating; viewer rendering belongs with #16. NOTE:
  `getCanvas` already returns `documentation` to capability-slug viewers (used
  by the owner's `commitDocumentation` cache snapshot); the viewer-render slice
  is what closes "shipped over the wire but not surfaced" — the next slice
  should either ship the read-only viewer or strip `documentation` from the
  slug-visible payload until it does.

## Consequences

### Reviewable invariants this slice adds

- "`Node.documentation` is markdown. The editor is a bridge — what persists is
  the serialized markdown string, never a Slate JSON value."
- "`updateNodeDocumentation` authorizes owner-only via `access.assertCanWrite`
  against the Node's Project, identity from the actor (never input). The
  capability slug never grants this write (ADR-0002)."
- "Docs autosave is optimistic on the `getCanvas` cache mirror and fire-and-
  forget; the mutation lives on the canvas so an editor unmount cannot abort it,
  and the editor flushes pending edits on blur / view-switch / unmount."
- "The supported markdown feature set is bounded and round-trip-lossy outside
  it; widening it is additive (plugin + `.plate-doc` style)."

### Costs accepted

- A heavy client dependency (Plate) enters the bundle — mitigated by lazy
  loading (off the canvas island's critical path) and hover-warming (off the
  click-to-edit critical path).
- Markdown fidelity is bounded by the plugin set; pasted exotic markdown
  degrades. Acceptable while docs are authored in-editor from an empty start.
  The editor surfaces a one-time `toast.warning` when a paste's serialized
  round-trip differs meaningfully from its source, so silent loss never
  passes unnoticed (the heuristic is lenient — false-positive toasts are
  harmless; a missed loss would be the failure).

### Follow-ups parked here for the next slice

- **`useOptimisticFieldCommit(field, mutation)` extraction.** `commitRename`
  and `commitDocumentation` on the canvas are now structurally identical
  (snapshot → optimistic patch → fire-and-forget → conditional rollback +
  toast; serialize-per-id for autosave). Two instances is the threshold; the
  third autosaving field is the extraction trigger — fold into a shared hook
  at that point, not before.
- **Capability-slug viewer rendering** (issue #16) — see §Alternatives.
