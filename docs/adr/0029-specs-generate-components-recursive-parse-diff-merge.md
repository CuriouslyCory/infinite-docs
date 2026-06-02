# 29. Specs generate Components: recursive parse, diff, and user-resolved merge

## Status

Accepted (#64).

**Supersedes** [ADR-0011](0011-flows-as-first-class-component-owned.md): Flows
as a first-class capability owned by a Node are gone (#62 removed the model and
its tables; this ADR replaces what they were for). A pasted Spec no longer
projects an owner-relative Flow set; it materialises a tree of ordinary child
**Components**.

**Amends** [ADR-0025](0025-flowspec-parser-registry-and-spec-kind-affinity.md):
the parser registry shape (kind-keyed, exhaustive `Record<SpecKind, …>`,
shared bounded loader, no `$ref` resolution) survives unchanged — only the
**output** is re-pointed from Flows to a recursive `ParsedComponent` tree. The
"rejected alternative" ADR-0025 named — *Spec → child Components instead of
Flows (a SQL schema explodes into TABLE sub-nodes with FK Connections)* —
**becomes the decision** here, vindicated by #62: with Flows gone there is no
routable model to project into, but Components are exactly the model an LLM and
the canvas both already understand.

**Builds on** [ADR-0008](0008-cascading-soft-delete-stamped-batch.md): a
generated Component is an ordinary subtree Node, so the existing recursive
descent + stamped `deletionId` cascade handles "delete this dropped subtree"
with no new arm. **Builds on** [ADR-0026](0026-apply-graph-batch-tool-shape.md):
the batch-create path (`apply_graph` / `createNode` composed under one
transaction) is reused for the "create new generated Components" arm —
correctness by construction (philosophy #6).

**Relates to** [ADR-0001](0001-service-layer-db-actor-input.md) (`(db, actor,
input)` service contract + `assertCanWrite`), [ADR-0010](0010-edge-dedup-partial-unique-index.md)
(the live-only partial unique index `idx_spec_owner_live` enforces 1:1 Spec per
Component across this slice's re-attach).

## Context

#62 retired the Flow capability model entirely: `Flow`/`FlowSpec`/`FlowRoute`
and their indexes are gone, the `Spec` model is renamed and reshaped to point at
derived child Nodes via `Node.sourceSpecId` + `Node.specKey`, and the cascade
arms exist — but no code yet *creates* a Spec or *generates* its children.
ADR-0025's parser registry was only ever documentation; with Flows gone there is
nothing for it to project into.

A pasted OpenAPI document or SQL DDL block is something both the user and the
LLM already think about as a tree of named, kinded things — `GET /pets`,
`POST /pets`, table `users`, column `email`. Those things ARE Components in our
model: a user-placed `EXTERNAL_API` should be able to descend into its parsed
endpoints; a user-placed `DATABASE` into its parsed tables and columns. The
product north star — an LLM-readable architecture — wants exactly that, with
the same nest/connect/descend/document affordances as any hand-placed
Component, so that an endpoint can be wired to the queue it pushes to or the
service that consumes it.

The user is also going to re-paste: an API evolves, a schema migrates. A
re-paste must NEVER silently destroy hand-authored documentation, drawn
Connections, or layout. The whole point of stable identity is that "the same
endpoint" survives re-parse.

## Decision

A Spec **generates child Components**, not Flows. "Generated" is a **provenance
modifier**, never a Component type: a generated Endpoint is an ordinary
`kind: ENDPOINT` Node that carries `sourceSpecId` + `specKey`; a generated Table
is an ordinary `kind: TABLE` Node. `GENERIC` is only the parser-can't-infer
fallback (parameters and columns today, until they earn their own kinds). A
generated Component nests, connects, descends, and is documented exactly like a
hand-placed one — it is just labelled as Spec-derived for the merge logic.

The shape rides three pieces that compose by construction:

1. **Recursive parse → `ParsedComponent` tree.** Each parser emits a recursive
   tree whose nodes carry `{ specKey, kind, title, documentation?, metadata?,
   children? }`. Depth is whatever the parser implements — ship OpenAPI
   (endpoint → params) and SQL-DDL (table → columns) shallow first, with nested
   request bodies summarised into `metadata`; deepen additively later with no
   model change. Anti-OOM safety bounds (node count cap, depth cap, source byte
   cap) are *not* feature limits: a breach surfaces a single `parseError` and
   the parser generates nothing (never partial). `specKey` anchors on the most
   stable per-format identity: OpenAPI's `operationId` when present else
   `METHOD path`; SQL table name; child keys are qualified by their parent's so
   they stay unique across the whole tree (parameter `GET /pets#query:limit`,
   column `users.email`). The parser is **pure** (no I/O, no clock, no `$ref`
   resolution) so the same source always yields the same tree — which is what
   makes the diff's stable-key matching deterministic and re-runs reproducible.

2. **Pure `parseSpecDiff`** classifies the parsed tree against existing
   generated children (`sourceSpecId` = this Spec) into `{ new[], changed[],
   dropped[], matchedKeyToId }`. Match key is `specKey`. A row is *changed* when
   its derived fields (title / kind / metadata) differ; **documentation is
   never compared** — once seeded on create, docs are user-owned. Pure: no DB,
   trivially unit-testable.

3. **User-resolved merge.** Nothing writes until the user confirms (cancel =
   zero writes). The conflict modal is driven by the diff:
   - *changed* → per-row skip / overwrite, plus a per-row keep-documentation /
     wipe-documentation toggle on overwrite. Bulk "skip all" / "overwrite all"
     are pure client conveniences that set per-row decisions. The default for
     an unresolved key is **skip** (safe).
   - *dropped* → per-row **keep (detach)** / delete. `keep` clears
     `sourceSpecId`+`specKey`, leaving the now-user-owned Component with its
     docs and Connections; `delete` soft-deletes the subtree and its incident
     Connections via the existing cascade (ADR-0008). The default for an
     unresolved nodeId is **keep** (non-destructive).
   - *new* are always created.
   - **Position and incident Connections are never in the prompt — always
     preserved.** Documentation is the only keep/wipe axis.
   - **Matched Components keep their Node id**, so Connections drawn to a
     generated Component survive re-parse.
   - The preview annotates each dropped row with whether its subtree has any
     incident live Connections, and the modal surfaces those rows prominently
     before apply so the loss is explicit.
   - First attach (no existing Spec, only `new[]`) **skips the modal and
     applies directly** — convenience philosophy.

The applier RE-PARSES and RE-DIFFS server-side from the saved `source` — the
client's tree is never trusted, because `source` is untrusted user-pasted
content (prompt-injection standing note). The whole apply runs inside one
transaction so a per-row reject rolls everything back; the existing
`applyGraph` insert path is reused for the *new* arm with `documentation` /
`metadata` / `sourceSpecId` / `specKey` added to `createNode` as additive
optional fields (the plain canvas create path is unchanged). The live Spec row
is 1:1 with its owner Component (`idx_spec_owner_live`); re-attach updates the
existing live row rather than inserting a second.

The web entry point is an explicit owner-only **"Attach spec"** section in the
Component detail panel (kind picker + paste textarea + Preview button). Viewers
never see it. The MCP spec-attach tool, the markdown export of generated
Components, and the project-wide "Connect to…" search are sibling issues
(#67, #66) — this slice stops at those seams.

## Consequences

- A pasted OpenAPI document or SQL schema deepens the architecture graph by
  exactly the affordances every other Component has: nest, connect, descend,
  document. The LLM-readable markdown export (#67) gets generated Components
  for free as ordinary nested Nodes with stable anchors.
- Re-parse is **non-destructive by default**: skip and keep are the safe
  defaults; only an explicit overwrite-wipe-docs or delete loses user content.
  Position and Connections are structurally unforgeable from this surface.
- `createNode` grows four additive-optional fields (`documentation`,
  `metadata`, `sourceSpecId`, `specKey`); existing call sites are unaffected
  (undefined = the plain canvas create).
- ADR-0011 is fully superseded; ADR-0025's structural decisions persist, only
  the output is re-pointed. "Generated" never appears as a `NodeKind` value —
  philosophy #6 (don't game the rule): provenance is what it is.
- The parser surface is small (`OPENAPI`, `SQL_DDL`); other `SpecKind`s remain
  `null` in the registry and surface a readable `parseError` until they are
  implemented — additive, no model change required.
- Bound enforcement is centralised in `enforceBounds`; node/depth caps live in
  one place and grow at one site if they ever need to.

## Rejected alternatives

- **Resurrect Flows for routability.** The product ask once read "routable like
  API endpoints," but #62 already eliminated the routable model on the
  conclusion that typed cross-scope Connections (ADR-0027 / ADR-0028) carry
  every shape Flows ever expressed. Re-introducing a parallel model now would
  fight that decision; an Endpoint Component drawn to a Service Component via
  REQUEST IS the routable thing.
- **Trust the client's parsed tree on apply.** The `source` is UNTRUSTED, and
  any client-resident parser is itself a soft target. Re-parsing on the server
  is a one-line cost and pins the apply to the same code path that produced the
  preview — the diff is reproducible.
- **A `GENERATED` NodeKind.** Forces every kind-keyed feature (icons,
  affinity, picker grouping) to fork on provenance; defeats the goal that a
  generated Endpoint and a hand-placed Endpoint render and behave alike.
- **Best-effort partial parse on a bounds breach.** Silently truncated trees
  fail open: the diff would mark the missing tail as *dropped* on the next
  clean re-parse and offer to delete real Components. Atomic generate-nothing
  fails closed and keeps re-parse identity intact.
- **Overwrite the existing Spec row on re-attach by inserting a fresh one.**
  Would violate the live-only `idx_spec_owner_live` index. Reusing the live
  row preserves the 1:1 invariant and the spec's history for any future
  tombstone-based undo.

## Test plan

Service tests (vitest, real test DB) for:
- Parser tree shape + `specKey` anchors (OpenAPI `operationId`, falls back to
  `METHOD path`; SQL table name; column keys qualified by table).
- Bounds breach (depth / node count / duplicate `specKey`) → single
  `parseError`, generate nothing.
- `parseSpecDiff` new / changed / dropped classification; matched keys preserve
  Node id.
- First attach silently creates the tree.
- Re-parse with overwrite (keep / wipe docs), skip, keep (detach), delete —
  each preserves the expected invariants (position, incident Connections;
  detach clears `sourceSpecId`+`specKey`).
- Dropped-with-incident-Connections is flagged in the preview.
- Re-attach reuses the live `Spec` row (no `idx_spec_owner_live` violation).

dev-browser end-to-end: paste OpenAPI onto a Component, confirm children
appear; re-paste a modified spec, walk each section of the modal, confirm the
graph matches the resolutions; cancel commits zero writes.
