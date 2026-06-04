# 37. The MCP agent skill is hand-authored prose; only its tool/resource NAMES are machine-guarded against catalog drift

## Status

Accepted (#95).

**Builds on** [ADR-0022](0022-authenticated-mcp-read-surface.md): the authenticated
MCP read surface and its generated `/llms.txt` discovery document already render
from the live catalogs. The skill DEFERS every endpoint / auth / error wire
specific to that served `/llms.txt` (which never drifts — it is generated from
`READ_RESOURCES` / `WRITE_TOOLS`) rather than restating it.

**Honours** [ADR-0017](0017-deterministic-markdown-serialization.md),
[ADR-0026](0026-apply-graph-batch-tool-shape.md),
[ADR-0027](0027-connection-carries-its-own-interaction.md),
[ADR-0029](0029-specs-generate-components-recursive-parse-diff-merge.md),
[ADR-0031](0031-cross-scope-read-derivation-and-per-edge-boundary-proxy.md): the
skill's mental-model prose must not contradict these contracts — deterministic
markdown + `{#nodeId}` anchors are READ output (not a write format), `apply_graph`
`clientId` chaining and the explicit `{ref}` discriminator, a Connection carries
its own `interaction` and spans any scope, `apply_spec` parses server-side, and a
boundary proxy's identity is fully derived (read-only).

**Honours** [ADR-0021](0021-api-token-scopes-stored-not-enforced.md): the skill
describes the token honestly — it acts AS the minting user and both reads and
mutates that user's projects; it is never a "read-only token."

## Context

An AI agent that lands on the infinite-docs MCP endpoint cold needs to learn how to
DOCUMENT a system as a nestable architecture graph — the vocabulary (Component,
Connection, Canvas, boundary proxy), the read ladder, the `apply_graph`-vs-surgical
decision, `clientId` chaining, the no-delete consequence — not just the wire
protocol. The served `/llms.txt` (ADR-0022) is a reference: it enumerates the
endpoint, auth, resources, and tools, but it deliberately is not a teaching
artifact and does not walk the agent through a documenting workflow.

A hand-authored skill closes that gap, but introduces a drift hazard: if it
restates the tool/resource set in prose, adding or renaming a catalog entry
silently desynchronizes the skill from the live surface. We want the teaching
prose to be human-authored (a generator cannot produce a faithful mental model),
yet the one machine-checkable fact the skill embeds — the set of tool and
resource NAMES — must be guarded.

## Decision

1. **The skill is hand-authored prose, NOT generated.** `SKILL.md` plus three
   `reference/` files teach the mental model, the connect/discover entry, the
   six-step documenting workflow, the read resources / write tools, worked
   examples, and the trust + error contract — compressed faithfully from
   `CONTEXT.md`, in the project's user-facing vocabulary.

2. **It points at the live `/llms.txt` for endpoint / auth / error mechanics**
   rather than duplicating them, so those wire specifics have exactly one source
   (the generated doc) and cannot drift from the catalog.

3. **It embeds only the tool/resource NAMES, in a `manifest.json`,** and a drift
   test (`src/server/mcp/__tests__/skill-manifest.test.ts`) asserts **set
   equality** (both directions) between `manifest.mcp.tools` and `WRITE_TOOLS`'
   names, and between `manifest.mcp.resources` and `READ_RESOURCES`' names. The
   manifest is the single shared name list the skill and the test read.

4. **No server / tool / resource / auth / schema / `llms.txt` change.** The slice
   is an authored artifact plus one test; the MCP surface is untouched.

## Consequences

- Adding (or renaming) a catalog tool or resource **fails the drift test** until
  the manifest — and the skill prose that teaches it — is updated. Docs travel
  with the slice that changes the surface; the skill cannot silently fall behind.
- The mental-model prose is **review-verified, not machine-verified**: only the
  name set is guarded. A faithfulness checklist in the implementation plan, and
  ADR review, carry the rest.
- **Reviewable invariant — set equality, not subset.** The test checks both
  directions: every manifest name is a real catalog name AND every catalog name
  appears in the manifest. Weakening it to a subset (manifest ⊆ catalog only)
  would let a newly added catalog entry go untaught and undetected — a regression.
- **Reviewable invariant — names key on the catalog `.name`.** The test reads
  `WRITE_TOOLS[].name` / `READ_RESOURCES[].name`, the same strings the SDK
  registration and `/llms.txt` render from. Keying the guard on anything else
  (titles, hand-typed literals) would let the guarded set diverge from the live
  surface.
- **Reviewable invariant — the skill never instructs mutating a boundary proxy.**
  A boundary proxy is a read-only, derived stand-in (ADR-0031); the skill must
  only ever teach reading it, never create/edit/move/delete. This is prose, so it
  rests on review, not the type checker.
- Switching the skill to a generated artifact, weakening the test to subset-only,
  or duplicating `/llms.txt`'s endpoint/auth/error mechanics into the skill are
  each reviewable regressions against this ADR.
- A future `stability` / experimental flag on a catalog descriptor would filter
  the reverse (catalog → manifest) direction of the test, so an unstable entry
  need not be taught yet. No such flag exists today; the test marks the seam.

## Does NOT touch

The MCP server, tools, resources, auth gate, Prisma schema, and the generated
`/llms.txt` route are unchanged. The footprint is the new skill files, the new
drift test, this ADR, and a `CONTEXT.md` glossary entry.
