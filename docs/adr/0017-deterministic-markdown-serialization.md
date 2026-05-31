# 17. Deterministic markdown serialization: codepoint order, AST heading-shift, pure-serializer / authorized-fetch split

## Status

Accepted (M2 / #15 — Deterministic markdown export). Builds on
[ADR-0001](0001-service-layer-db-actor-input.md) (the `(db, actor, input)`
service contract and single-round-trip read posture),
[ADR-0002](0002-capability-url-sharing.md) (the slug is the read grant; writes
are owner-only), [ADR-0006](0006-breadcrumbs-single-recursive-query.md)
(raw-SQL discipline + recursive CTE pattern), and
[ADR-0015](0015-component-docs-plate-markdown-autosave.md) (the markdown
string in `Node.documentation` is the source of truth).

## Context

The graph leaves the app as markdown for two consumers: a human hitting "Copy
as markdown", and (next, via #18) an authenticated MCP agent reading the
architecture. "Deterministic" is load-bearing: #18's read resources and
Slice 5 / #38's Flow golden test both assume the same graph always serializes
to the same bytes, regardless of when, where, and under which OS locale the
serializer runs. The export is locked with a golden-file byte-equality test
so a silent format drift fails CI rather than slipping into a downstream LLM
context.

Three forces shape the design:

1. **The format must be byte-stable.** Random ids (cuid), timestamps,
   locale-sensitive sorts, and library-default formatting all defeat
   byte-equality silently. Each one needs an explicit answer encoded in code,
   not a comment.
2. **The serializer is consumed by more than one caller.** An MCP read path
   (#18) holds a bearer-token Actor, not a slug; #38's Slice 5 extends the
   format additively with Flow / FlowRoute sections. The serializer must be
   reusable across those callers without re-implementing the format, and the
   format must extend without re-baselining what's here.
3. **Performance posture is unchanged.** Reads stay depth-independent — no
   per-level query walk (ADR-0001) — and the new procedure is slug-readable
   (works for any link viewer; ADR-0002).

## Decision

### 1. The determinism contract (encoded in `~/server/architecture/markdown.ts`)

Four rules, each load-bearing:

- **Order is computed in application code with a Unicode codepoint
  comparator.** Postgres `ORDER BY` is collation-aware (the database / column
  collation can be locale-sensitive, and is ambiguous for collation-equal
  strings); JS `String#localeCompare` and `Intl` are the only locale-sensitive
  JS primitives. The serializer sorts with plain `<`/`>` operators which
  compare UTF-16 code units. **`localeCompare` and `Intl` are banned in this
  module**; the locale-mutation test in
  `markdown-export.test.ts` mutates `LANG`/`LC_ALL`/`LC_COLLATE` and asserts
  byte-equal output, so the ban is enforceable not just aspirational.

- **No timestamps in the output.** `createdAt` and `updatedAt` are never
  serialized; the export header carries only counts.

- **Authored documentation is heading-shifted via an mdast AST walk, never via
  regex.** A regex over lines starting with `#` would corrupt fenced code
  blocks and inline `#` characters; the AST walk (`unist-util-visit` over
  `remark-parse` output) only ever touches `heading` nodes. The transform
  clamps depth at 6 (the mdast maximum). One test guards this directly: a doc
  with a `#`-prefixed line *inside* a fenced code block must round-trip with
  the code block intact.

- **`remark-stringify` options are pinned explicitly.** `bullet`,
  `bulletOther`, `emphasis`, `strong`, `rule`, `ruleSpaces`, `fences`,
  `setext`, `tightDefinitions`, `listItemIndent` all carry library-default
  values that could flip across versions and silently re-baseline the golden
  file. Pinning every option that affects output bytes turns "format drift
  via dependency bump" into a deliberate, reviewable change.

Together these turn locale invariance and version stability from disciplines
into **invariants enforced by the test suite**.

### 2. Reproducibility for the golden test: seed fixed ids

`createNode` / `createProject` mint cuid ids by default — random by design.
A golden file that includes `{#<nodeId>}` anchors (it does, intentionally —
the export is addressable for #18) cannot be byte-equal across runs if the
ids are random. The integration test therefore inserts directly via
`testDb.{project,node,edge}.create({ data: { id: "n-api", … } })`, bypassing
the cuid default. Production paths keep cuids; the test stays reproducible.

### 3. The pure-serializer / authorized-fetch split

The implementation is two modules:

- **`~/server/architecture/markdown.ts`** — `serializeGraph(input)`: pure,
  side-effect-free, takes a fully-fetched `SerializerInput` and returns a
  string. No `db`, no `actor`, no I/O. This is the unit #18 reuses behind a
  bearer-token Actor without re-implementing the format.

- **`~/server/architecture/export.service.ts`** — `exportMarkdown(db, actor,
  input)`: the `(db, actor, input)` service shape (ADR-0001). Resolves the
  Project by slug (ADR-0002 — the slug is the read grant); bulk-fetches the
  graph (whole-project: two flat reads; subtree: three concurrent raw queries
  for descendant Nodes, descendant Edges, and ancestry-based boundary
  context); delegates to `serializeGraph`.

Importantly: the subtree fetch does **not** issue a Nodes-then-Edges
waterfall. The two share the same descent CTE shape and run in parallel,
trading one extra recursive walk on the server for a flat round trip — the
same posture `getCanvas` adopts for breadcrumbs vs interior reads. The
boundary CTE is a leaner variant of `deriveBoundaryProxies`
([ADR-0012](0012-routeflow-sole-cross-scope-edge-writer.md)) without the
Flow palette aggregation — Flows are #38's surface and would only inflate
this payload.

### 4. The three export modes

- **Full project** (`canvasNodeId: null`, `mode: "full"`): every Component
  in the project; Connections section; no Boundary section (the root has no
  ancestors).
- **Subtree** (`canvasNodeId: R`, `mode: "full"`): R + descendants;
  Connections scoped to any Canvas inside the subtree; a **Boundary context**
  section enumerates the externals incident to R on its parent Canvas, so
  the export is self-describing (the AC).
- **Index** (`mode: "index"`): a cheap structural map — titles, kinds,
  anchors, indented by depth, with a per-Component "X connections" count.
  Doc bodies omitted; Connections section omitted. The cheap navigable view
  #18's read-index resource will return.

### 5. Anchors: `{#nodeId}`

Each Component section / index entry carries an addressable HTML-style
anchor (`{#<nodeId>}`). Bare-id is enough because the project is fixed for
the export and stated once in the header; #38's Flow anchors
(`projectId#nodeId#flowKey`) extend this additively.

### 6. The format extends additively — never re-baseline

#38 (Slice 5) extends this format with a `### Flows (…)` Component subsection
and a `flows:` Connection subsection. Both are **strict insertions** under
existing blocks; nothing in the #15 layout shifts. The #15 golden fixture
stays valid for the non-Flow portion; #38 adds its own Flow-bearing fixtures
rather than re-baselining what's here. This is why the format leaves the
existing Components / Connections sections single-purpose and unornamented.

## Consequences

- **"The serializer never reaches for `localeCompare` / `Intl`" is a
  reviewable invariant.** A future change that adds `Intl.Collator` for
  "nicer" sorting is a regression against this ADR, not a refinement — the
  locale-mutation test will fail.

- **The round-trip canonicalizes authored formatting.** `*foo*` → `_foo_`,
  setext-style underlines → ATX `#`, mixed bullets → `-`, etc. — acceptable
  and arguably desirable: the LLM-facing surface is consistent regardless of
  how the docs were typed.

- **A remark version bump can be a silent format change.** Mitigated by
  pinning every stringify option that affects bytes; backstopped by the
  golden file (CI fails on drift). The fix for an intentional change is
  `UPDATE_FIXTURES=1 pnpm test markdown-export` + commit, never a
  format-tolerant assertion.

- **`processSync` requires a sync-only plugin chain.** `remark-parse` and
  `remark-stringify` are both sync; do not add an async remark plugin to this
  processor without switching `processSync` → `processSync` is impossible →
  restructure to async.

- **The serializer reads `Node.documentation` verbatim.** Component
  documentation, titles, and Connection labels are all UNTRUSTED user content
  (prompt-injection standing note, CONTEXT.md). Active fencing of those
  fields for hostile-LLM-input is **deliberately out of scope here** — #15 is
  the first code path crossing the output/serialization boundary the standing
  note names. The current defense is structural separation (each field
  rendered inside its own clearly-bounded section) and verbatim storage; a
  later milestone can add active output-side defenses without changing this
  ADR's contract.

- **Cuids are non-reproducible.** Any future caller writing a golden test
  against the serializer or `exportMarkdown` must seed ids explicitly via
  direct `db.*.create({ data: { id, … } })` (the pattern this ADR
  establishes), never via service writers that mint cuids.

- **This is the second adopter of the raw-SQL recursive-CTE pattern**
  (ADR-0006). Keeping the same identifier-quoting discipline, the same bound-
  parameter posture, and the same `ANCESTRY_DEPTH_CAP` value preserves a
  single mental model for anyone reading these queries.
