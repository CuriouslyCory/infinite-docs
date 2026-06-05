# 44. Cross-project connection management: a stamped-batch cascade sweep keyed on the host endpoints, a host→foreign directional dedup index, cross-boundary "Go to" via the `?via=` crossing stack, and an export that emits non-recursive reference markers that never inline foreign content past the per-actor firewall

## Status

Accepted (#123, the second Cross-Project Connections slice — management).

**Discharges** [ADR-0043](0043-cross-project-connections-host-anchored-crossprojectedge.md)
§7: that ADR shipped create + render only and named delete/restore, dedup,
cross-boundary "Go to," and export markers as the explicit seam to **#123**. **This
is that slice** — it wires the present-but-unwired `deletionId`, adds the dedup
index that ADR-0043 deliberately withheld, gives the foreign proxy its "Go to," and
teaches the serializer to emit cross-project markers, **without** a new column or
table beyond what ADR-0043 already laid down. **Extends**
[ADR-0008](0008-cascading-soft-delete-stamped-batch.md) /
[ADR-0030](0030-cascade-undo-without-flowroutes.md): the host-node cascade sweep
gains an **additive `CrossProjectEdge` arm**, stamped under the **same** host-node
`deletionId` batch, keyed on the **host** endpoints (`hostNodeId ∈ S ∨
referenceNodeId ∈ S`) with the foreign columns excluded. **Honors**
[ADR-0014](0014-deleteedge-restoreedge-cascade.md): a **lone** delete of one
`CrossProjectEdge` mints **no** `deletionId` — the conditional-`deletionId` carve-out
(a lone soft-delete is not a cascade) carried across the project seam. **Adopts**
[ADR-0010](0010-edge-dedup-partial-unique-index.md) as its **third adopter** — the
hand-authored partial-unique-index pattern — but with a **directional** key, never
the `Edge` table's `LEAST`/`GREATEST` symmetric one. **Extends**
[ADR-0017](0017-deterministic-markdown-serialization.md) **additively** (amended in
lockstep with this slice): the serializer gains non-recursive reference markers,
existing golden fixtures byte-untouched. **Upholds**
[ADR-0041](0041-cross-project-embedding-per-actor-portal.md): the export is the
**last firewall point** — a non-recursive marker upholds the per-actor firewall, an
inlined foreign subtree breaches it (the §3 leak); cross-boundary "Go to" reuses the
**`?via=` crossing stack** (ADR-0041 §5/§6). **Bounded by**
[ADR-0022](0022-authenticated-mcp-read-surface.md): a reference is **not** a grant —
it never widens `listProjectsForActor` and never admits the foreign project to the
MCP `resources/list` own-grant surface.

## Context

ADR-0043 admitted the first link that genuinely spans two projects — a
`CrossProjectEdge` from a host Component to a specific interior Node of an embedded
project — but shipped it deliberately inert: created and rendered, never deleted,
de-duped, navigated through, or exported. Its `deletionId` column was **present but
unwired**, no dedup index backed it, the foreign proxy was a **passive marker** with
no "Go to," and the markdown export was **untouched** so the golden file stayed
byte-stable. ADR-0043 §7 named all four as the seam to **#123** and told reviewers
not to flag their absence. This slice closes that seam, and each of the four forces a
question the create-only slice never had to answer.

- **When a host Component (or the portal it routes through) is deleted, what happens
  to its incident cross-project links?** The host-node cascade already gathers a
  subtree into one stamped `deletionId` batch (ADR-0008/0030) so it can be undone
  atomically. A `CrossProjectEdge` is anchored in the host graph (its host columns are
  real cascading FKs, ADR-0043 §1), so it must be swept **with** that batch — but the
  sweep predicate must key on the **host** endpoints only, never the foreign columns,
  or a host delete would reach across the seam to decide a foreign row's fate. And a
  **lone** delete of a single link is not a cascade and must not mint a `deletionId`
  (ADR-0014).

- **What makes two cross-project links "the same," and where is that enforced?** The
  `Edge` dedup indexes are symmetric (`LEAST`/`GREATEST` over the endpoint pair,
  ADR-0010) because an undirected Connection `A—B` equals `B—A`. A cross-project link
  is **not** symmetric: it is **directional**, host→foreign, and the foreign end is a
  plain reference, not a graph endpoint that could anchor the other direction. The key
  must be host→foreign, and it must live in its **own** index — the `Edge` indexes stay
  byte-unchanged (ADR-0043's whole premise).

- **Can the foreign proxy's "Go to" cross the project seam?** Intra-project "Go to"
  descends `parentId` ancestry, which physically cannot cross a project boundary
  (ADR-0041 §7). Crossing into the foreign endpoint's scope must reuse the **`?via=`
  crossing stack** (ADR-0041 §5/§6) — stay on the **host** URL, push a crossing, and
  **re-gate per-actor** at the crossing, exactly as portal descent does.

- **How does a cross-project link leave the app as markdown without leaking foreign
  content?** The serializer is **pure and actor-less** (`serializeGraph`, ADR-0017
  §3) — it holds no Actor and cannot re-gate. If the export followed the pointer into
  the foreign project's serialization, it would inline foreign content **past** the
  per-actor firewall, the exact ADR-0041 §3 leak, at the one boundary (export) where
  the firewall is last enforceable. The marker must **stop** at the seam.

## Decision

### 1. The host-node cascade gains an additive `CrossProjectEdge` sweep arm, stamped under the same `deletionId` batch and keyed on the host endpoints; a lone delete mints no `deletionId`

Deleting a host Component (or a portal the link routes through) sweeps its **incident
`CrossProjectEdge` rows** into the **same stamped batch** as the host-node cascade
(ADR-0008/0030): one `deletionId`, gathered by the existing single recursive descent,
so the whole cascade reverts atomically. The sweep arm is **additive** — a new arm
alongside the descendant-`Node`, descendant-`Edge`, and `Spec` arms (ADR-0030),
never a rewrite of the gather.

The sweep predicate keys on the **host** endpoints only:

```
hostNodeId ∈ S  ∨  referenceNodeId ∈ S
```

where `S` is the set of host-node ids in the cascade subtree. The **foreign columns
(`foreignProjectId`/`foreignNodeId`) are excluded from the predicate** — a host delete
never consults, and never decides the fate of, anything on the far side of the seam.
This is the host-anchored posture of ADR-0043 §2 expressed as a delete rule: the
sweep lives entirely in the host graph.

A **lone** `deleteCrossProjectEdge` (one row, not a cascade) is a **lone soft-delete**:
it stamps `deletedAt` and mints **no `deletionId`** — the ADR-0014 conditional-
`deletionId` carve-out (a `deletionId` marks a _cascade_ batch for atomic undo; a lone
delete has nothing to batch), carried across the project seam. `restoreCrossProjectEdge`
is its **single-row inverse** — clear `deletedAt`, restoring exactly that row. A
cascade undo, by contrast, reverts the whole `deletionId` batch (host node + swept
cross-project rows together), exactly as ADR-0030's component undo does.

### 2. A directional partial-unique dedup index `(hostNodeId, foreignProjectId, foreignNodeId, interaction) WHERE deletedAt IS NULL`, adopting ADR-0010's pattern — never its symmetry

De-dupe is backed by a **hand-authored partial-unique index** on `CrossProjectEdge` —
the **third adopter** of the ADR-0010 raw-SQL pattern (the `Edge` table's two indexes
are the first two), authored as raw SQL because Prisma cannot express a partial unique
index. The key is:

```
UNIQUE (hostNodeId, foreignProjectId, foreignNodeId, interaction)
  WHERE deletedAt IS NULL
```

Four properties are load-bearing, each a reviewable invariant:

- **Directional, never symmetric.** The key is the ordered host→foreign tuple. It does
  **not** wrap the endpoints in `LEAST`/`GREATEST` the way `idx_edge_dedup` does. A
  cross-project link is directional (host references foreign; the foreign end is a
  plain reference column, ADR-0043 §1, not a graph endpoint that could anchor the
  reverse). Symmetric collation here would be a category error — there is no `B→A` row
  to collide with.
- **`referenceNodeId` and `label` are OUT of the key.** The same host→foreign pair
  routed through two **different portals** (`referenceNodeId`) is the **same** logical
  dependency, de-duped to one row; the portal is a routing fact, not an identity. The
  `label` is untrusted display content (ADR-0043 §6), never an identity discriminator.
- **`interaction` is IN the key.** `host→foreign REQUEST` and `host→foreign PUSH` are
  **distinct** active links (ADR-0027: a Connection carries its own Interaction), the
  same reasoning the `Edge` dedup amendment used to admit `A→B REQUEST` alongside
  `A→B PUSH` (ADR-0017 §"Sort key").
- **The partial `WHERE deletedAt IS NULL` is mandatory.** Only **live** rows collide;
  a soft-deleted link must not block re-creating the same dependency, and the
  delete→re-create→restore lifecycle (§1) must never deadlock against the index. The
  predicate is the same partial-uniqueness discipline ADR-0010 established.

Enforcement is **service-primary with a database backstop**: `connectCrossProject`
checks for a live duplicate and rejects with a clean `ConflictError` (a legible
domain error, not a raw constraint violation); the index is the **race-safe backstop**
that turns a concurrent double-insert into a `P2002` the service maps to the same
`ConflictError`. Service-first for the message, index-backed for the race — the
ADR-0010 posture.

### 3. Cross-boundary "Go to" reuses the `?via=` crossing stack, stays on the host slug, and re-gates per-actor at the crossing

The foreign boundary proxy gains a cross-boundary **"Go to"**: it descends into the
**foreign endpoint's own scope** — not the portal root, the specific interior Node the
link points at. It does **not** mint a new route shape. It **pushes a crossing onto the
`?via=` crossing stack** (ADR-0041 §5/§6) and the URL **stays under the host slug**
(`/p/[hostSlug]/n/[foreignNodeId]?via=…`) — the foreign project's capability-URL slug
is **never** exposed (ADR-0002 / ADR-0041 §5), only its internal id rides the crossing.

The crossing is **re-gated per-actor** at the seam, exactly as portal descent gates
once per crossed segment (ADR-0041 §6): the foreign project is re-resolved via
`resolveReadableProjectById` (`none → NotFound`, non-disclosing). An actor whose
foreign grant was revoked after the link was authored finds the "Go to" collapses to
not-found — the **same per-actor re-gate** that already makes the proxy _render_ absent
(ADR-0043 §5), now governing _navigation_ into it. There is **no write** on a "Go to":
re-gating is a pure read-time derivation.

### 4. Export emits non-recursive reference markers, re-gated per-actor in `export.service`, never `markdown.ts` — and never inlines foreign content (the per-actor firewall at the export boundary)

The markdown / MCP export learns to emit **portals** (ADR-0041) and **cross-project
links** (ADR-0043) as **non-recursive reference markers**: a terminal line naming the
**foreign project title** and the **foreign endpoint title/kind**, and then it
**stops**. The marker **never follows the pointer** into the foreign project's
serialization — it does not inline the foreign Component's docs, its interior, or any
foreign content.

The non-recursion is a **security boundary, not a formatting choice**. `serializeGraph`
is **pure and actor-less** (ADR-0017 §3) — it holds no Actor and cannot re-gate a
crossing. If the serializer inlined the foreign subtree, it would emit foreign content
**past** the per-actor firewall, at the **export boundary** — the one place ADR-0041's
firewall is last enforceable before bytes leave the app. That is the ADR-0041 §3 leak.
So the **per-actor re-gate for the marker lives in `export.service.ts`** (the
`(db, actor, input)` shape that _can_ re-gate, ADR-0017 §3), **not** in pure
`markdown.ts`: `export.service` resolves each marker's foreign endpoint per-actor
(`≥ view`) and hands `serializeGraph` only what survived the gate. A marker whose
foreign end is **unreadable for this actor, soft-deleted, or dangling** is **absent**
from the output — the render-time "proxy absent" posture (ADR-0043 §5), carried to the
export boundary.

The marker is **deterministic** under the ADR-0017 four-clause contract (amended in
lockstep): ordered by **codepoint comparator over a host-stable key** (never a foreign
cuid, never `Map`/`Set` iteration order), it emits **no foreign `{#nodeId}` anchors**
(the foreign project is addressed only inside its own export, never here), and it is a
**strict additive insertion** — the three existing golden fixtures stay **byte-untouched**,
new marker-bearing fixtures lock the new form (ADR-0017 amendment §"#123").

### 5. A reference is not a grant: the foreign project never enters `listProjectsForActor`, and the MCP read surface stays own-grant gated

Authoring or rendering a cross-project link (or a portal) **grants the actor nothing**
on the foreign project. The foreign project **never enters `listProjectsForActor`** for
an actor who lacks their **own** grant on it — a reference is a _pointer_, not a
capability. Concretely: an ungranted actor cannot **enumerate** the foreign project (it
is absent from their project list and the portal picker, ADR-0041 §"picker") and cannot
**dereference** `architecture://project/{foreignId}` — the MCP `resources/list` surface
stays **own-grant gated** (ADR-0022: the MCP read surface lists only what the token
Actor's own capability admits), unwidened by any incident reference.

This is the firewall §4 enforces at the export boundary, stated as a membership rule:
the reference discloses the foreign **title** (the marker), never **read access** to the
foreign graph. The two seams agree — the marker names, the grant gates, and neither
leaks the other's authority.

## Consequences

- **Reviewable invariant — the cascade sweep arm is additive and host-keyed.** A host
  Component / portal delete sweeps incident `CrossProjectEdge` rows into the **same**
  `deletionId` batch (ADR-0008/0030), predicate `hostNodeId ∈ S ∨ referenceNodeId ∈ S`,
  **foreign columns excluded**. A sweep predicate that consults `foreignProjectId` /
  `foreignNodeId`, or that stamps the swept rows under a _separate_ batch, regresses
  this ADR — a host delete must decide only host-graph fates, atomically with its own
  cascade.
- **Reviewable invariant — a lone delete mints no `deletionId`.** `deleteCrossProjectEdge`
  on a single row stamps `deletedAt` and **no `deletionId`** (ADR-0014 carve-out);
  `restoreCrossProjectEdge` is its single-row inverse. A lone delete that mints a
  `deletionId`, or a cascade sweep that does **not**, regresses the conditional-
  `deletionId` rule.
- **Reviewable invariant — the dedup index is directional and partial.** The index is
  `(hostNodeId, foreignProjectId, foreignNodeId, interaction) WHERE deletedAt IS NULL`:
  directional (**no** `LEAST`/`GREATEST`), `referenceNodeId` and `label` **out**,
  `interaction` **in**, partial `WHERE` **mandatory**. A symmetric key, a key that
  admits `referenceNodeId`, or a non-partial index regresses ADR-0010's third adoption.
  The two `Edge` indexes stay **byte-unchanged** (ADR-0043's premise).
- **Reviewable invariant — dedup is service-primary, index-backed.** `connectCrossProject`
  rejects a live duplicate with `ConflictError`; the index backstops the race
  (`P2002 → ConflictError`). Relying on the index alone (raw constraint error to the
  client) or the service alone (no race protection) regresses the ADR-0010 posture.
- **Reviewable invariant — "Go to" rides `?via=` under the host slug, re-gated per
  crossing.** Cross-boundary "Go to" pushes a `?via=` crossing (ADR-0041 §5/§6), keeps
  the URL on the **host** slug (foreign slug never exposed, ADR-0002), and re-gates the
  foreign project per-actor (`none → NotFound`). A "Go to" that routes under the foreign
  slug, or that trusts the create-time grant instead of re-gating, regresses this ADR.
- **Reviewable invariant — the export marker is non-recursive and never inlines foreign
  content.** A portal / cross-project link serializes as a terminal marker (foreign
  title + endpoint title/kind) and **stops**. Following the pointer into the foreign
  serialization — inlining foreign docs or interior — breaches the per-actor firewall at
  the export boundary (the ADR-0041 §3 leak), because `serializeGraph` is actor-less and
  cannot re-gate. Any inlining regresses this ADR.
- **Reviewable invariant — the marker's per-actor re-gate lives in `export.service`, not
  `markdown.ts`.** `export.service.ts` re-gates each marker (`≥ view`) and feeds
  `serializeGraph` only what survived; the pure serializer never re-gates. Moving the
  gate into pure `markdown.ts`, or emitting a marker the service did not gate, regresses
  the pure-serializer / authorized-fetch split (ADR-0017 §3).
- **Reviewable invariant — the export stays deterministic and additive.** Markers sort
  by a **host-stable codepoint key** (never a foreign cuid or `Map`/`Set` order), emit
  **no foreign `{#nodeId}` anchors**, carry no timestamps, and are **strict additive
  insertions** — the three existing golden fixtures stay **byte-untouched** (ADR-0017
  amendment). A marker keyed on foreign-id order, or one that shifts an existing fixture,
  regresses ADR-0017's determinism contract.
- **Reviewable invariant — a reference is not a grant.** The foreign project never enters
  `listProjectsForActor` and never joins the MCP `resources/list` own-grant surface for
  an actor lacking their own grant (ADR-0022). A reference that widens either enumeration
  regresses this ADR — the marker discloses the foreign **title**, never **read access**.
- **`pnpm check` cannot see any of this.** The cascade sweep arm, the lone-delete
  `deletionId` carve-out, the delete/restore round-trip, the directional-dedup rejection,
  the `?via=` host-slug "Go to," the export emitting a **marker (not inlined content)**
  and that marker being **absent when the foreign grant is revoked**, and the
  foreign-project **non-leak** into `listProjectsForActor` are all runtime / authorization
  / serialization behavior ESLint and `tsc` cannot assert. Their correctness rests on the
  Vitest service tests against real Postgres (ADR-0003): delete→restore round-trip; the
  cascade sweep on a host-node delete (and lone-delete minting no `deletionId`); a
  duplicate host→foreign link rejected; "Go to" crossing under the host slug; the export
  emitting a marker rather than inlined foreign content, and that marker absent for a
  revoked grant; and a portal / cross-project link **not** surfacing the foreign project
  in `listProjectsForActor` for an ungranted actor.
- **Closes the ADR-0043 §7 seam.** Delete/restore (the now-wired `deletionId`), the
  cross-project dedup index, cross-boundary "Go to," and export markers — the four
  follow-ons ADR-0043 §7 named and told reviewers not to flag — all land here. The
  Cross-Project Connections feature is, with this slice, complete.
