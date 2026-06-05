# 43. Cross-project connections via a host-anchored CrossProjectEdge: a separate table preserves the Edge dedup indexes and the single-project ancestry CTE; authz = host edit + foreign view

## Status

Accepted (#122, the first Cross-Project Connections slice — create + render only).

**Builds on** [ADR-0041](0041-cross-project-embedding-per-actor-portal.md): §8 of
that ADR kept the seam clean — "no `Edge` spans a project; proxies stay within a
segment" — and pre-committed that "a future ADR may revisit it without unwinding
this one." **This is that ADR.** It admits a Connection from a host Component to a
specific Component _inside_ an embedded project, and does so **without** touching
the `Edge` table, its indexes, or the single-project ancestry CTE — so ADR-0041
§8 is honored, not reopened. **Preserves**
[ADR-0028](0028-cross-scope-connections-lineal-ingress.md): no `Edge` spans a
project remains **literally true**, because the cross-project link is a row in a
**different table** (`CrossProjectEdge`), never an `Edge`. **Builds on**
[ADR-0031](0031-cross-scope-read-derivation-and-per-edge-boundary-proxy.md): the
foreign end renders through the **same per-edge boundary-proxy machinery** — a
synthetic `nodeId`, a `realEndpointId`, a title/kind read live from the far Node
— reused, not re-invented. **Reuses**
[ADR-0036](0036-boundary-proxy-placement-persistence.md): the foreign proxy's
per-scope placement is the existing `BoundaryProxyPlacement` table keyed
`(containerNodeId, realEndpointId)`, unchanged. **Honors**
[ADR-0010](0010-edge-dedup-partial-unique-index.md): the two partial unique
indexes (`idx_edge_dedup` / `idx_edge_assoc_dedup`, both keyed on `projectId`)
stay **byte-unchanged**, because no cross-project row ever enters the `Edge`
table. **Honors** [ADR-0027](0027-connection-carries-its-own-interaction.md): the
cross-project link carries its **own** `Interaction`, the same as a Connection
does. **Honors** [ADR-0001](0001-service-layer-db-actor-input.md) /
[ADR-0006](0006-breadcrumbs-single-recursive-query.md): the foreign end is
derived by a **bounded service pass**, a fifth concurrent read in `getCanvas`'s
`Promise.all`, **never** by widening the recursive ancestry CTE.

## Context

A Connection today is an `Edge`, and an `Edge` is irreducibly single-project. Its
`projectId` scopes the row; the two dedup partial indexes
(`idx_edge_dedup`/`idx_edge_assoc_dedup`, ADR-0010) are keyed on that
`projectId`; and the cross-scope read derivation (`endpoint_walk`, ADR-0031)
climbs `parentId` ancestry **within one project** to resolve each endpoint onto a
scope. Every one of those assumes one graph. ADR-0028 made cross-_scope_ the
common case but left **cross-_project_** explicitly out, and ADR-0041 §8 sealed
that seam: no `Edge` references a foreign project, and boundary proxies derive
within a single segment.

The product now needs the next register: **"my component talks to their
component."** A user draws a Connection from a host Component to a **specific
Component inside an embedded project** (the foreign end is not the portal, not the
foreign root — a particular interior Node), and sees it rendered in the host
scope. This is the first link that genuinely **spans two projects**, and it forces
four questions the single-project `Edge` never had to answer.

- **Where does the link live — on `Edge`, or somewhere else?** A foreign-pointing
  `Edge` column would drag a foreign `projectId`/`nodeId` into the very table
  whose dedup indexes and ancestry CTE assume one project. Either the indexes and
  the CTE absorb a cross-project case (a wide, error-prone change to the most
  load-bearing read in the app), or they silently skip it (a correctness gap). And
  it would make ADR-0028's "no `Edge` spans a project" **false**.
- **Whose graph does the link belong to — the host's or the foreign's?** The link
  is the host saying something about its own dependency on foreign content. Writing
  it into the foreign project's graph would mutate a project the actor may only
  _view_, and would make the foreign project, viewed standalone, sprout an edge it
  never authored.
- **Whose capability governs creating it?** The host owner may have no grant at
  all on the foreign project (ADR-0041 §3: the host's capability never governs
  foreign content). Reusing the host capability to reach foreign Components would
  be a cross-project privilege leak.
- **How does the foreign end render without re-walking ancestry across the seam?**
  `parentId` cannot cross a project boundary (ADR-0041 §7), so the recursive CTE
  physically cannot resolve a foreign endpoint. The far end must surface some other
  way — and it must degrade, never break, if the foreign content moves or the grant
  is revoked.

## Decision

### 1. A separate host-anchored `CrossProjectEdge` table, never an `Edge` column

The cross-project link is a row in a **new table**, `CrossProjectEdge`, **never** a
column added to `Edge`:

```prisma
CrossProjectEdge {
  id,
  hostProjectId    (FK Project.id, onDelete Cascade),
  hostNodeId       (FK Node.id,    onDelete Cascade),
  referenceNodeId  (FK Node.id,    onDelete Cascade)  -- the portal it routes through
  foreignProjectId  -- PLAIN column, NOT an FK
  foreignNodeId     -- PLAIN column, NOT an FK
  interaction (Interaction), label?,
  deletedAt?, deletionId?, createdAt, updatedAt
}
```

The **host** columns (`hostProjectId`, `hostNodeId`, `referenceNodeId`) are real
foreign keys with `onDelete: Cascade` — they live in the host graph, so deleting
the host project, the host Component, or the portal the link routes through
removes the row, exactly as it would an `Edge`. The **foreign** columns
(`foreignProjectId`, `foreignNodeId`) are **plain reference columns, NOT foreign
keys**. The choice is load-bearing and deliberate: a cross-project FK would let a
**foreign** delete cascade **into the host** graph — precisely the hazard ADR-0041
chose `SetNull` to avoid (deleting a target must never reach into a graph that
merely points at it). A plain column points without coupling; a dangling reference
is a rendering condition (§5), never a cascade.

The reason the link is a separate table rather than an `Edge` column is the whole
point of this ADR: it keeps the `Edge` dedup partial indexes
(`idx_edge_dedup`/`idx_edge_assoc_dedup`, ADR-0010) **byte-unchanged**, keeps the
single-project ancestry CTE (`endpoint_walk`, ADR-0031/0006) **byte-unchanged**,
and keeps ADR-0028's "**no `Edge` spans a project**" **literally true** — because
nothing cross-project ever enters the `Edge` table. A reviewer can verify all
three invariants by confirming the `Edge` table, its indexes, and the CTE are
untouched by this slice.

### 2. Host-anchored: the foreign project, viewed standalone, never shows it

The link is **anchored in the host** — it records the host's reference to foreign
content, not a mutation of that content. It is **not written into the foreign
project's graph**: no `Edge`, no `Node`, nothing in the foreign project changes.
Open the foreign project directly and this link **does not appear** — it is a
pointer one register over (ADR-0041 §2: a pointer, not a snapshot; the host
references the foreign Component, it does not snapshot or mutate it). A foreign
viewer who is also a host editor authors the link entirely within the host graph;
the foreign project is read, never touched.

### 3. Authorization: host `edit` first, then foreign `≥ view`, re-resolved per-actor on every read

Creating a cross-project link (`connectCrossProject`) gates **in order**, and the
order is load-bearing for disclosure — the same shape as portal creation
(ADR-0041 §4):

1. **Host `edit` first** — `authorizeProjectWrite(host, "edit")` runs **before**
   anything foreign is resolved; a caller who cannot edit the host gets
   `ForbiddenError` and **never learns whether the foreign project or Component
   exists** (non-disclosing).
2. **Foreign `≥ view`** — only then is the foreign project re-gated via
   `resolveReadableProjectById` (the id-keyed read seam, ADR-0041 §3); a foreign
   project the actor may not read collapses to `NotFoundError`. You may link to
   **only what you can read**.

A **same-project or self link** (host and foreign the same project, or the foreign
Node being the host Node) is rejected with `ValidationError` — a same-project link
is an ordinary `Edge`, not this construct.

The foreign capability is **re-resolved per-actor on every read**, not stamped at
creation. If the actor's foreign grant is later revoked, the foreign proxy simply
**vanishes** from their host read (§5) — the row survives, but it surfaces nothing
to an actor who can no longer read the far side. There is **no write** on a read:
re-gating is a pure read-time derivation.

### 4. Render via a dedicated bounded pass — a fifth concurrent read, NOT the recursive CTE

In the host scope (or when descended through the portal the link routes through),
the foreign endpoint surfaces as a **boundary proxy**, derived by a **dedicated
bounded pass** in `getCanvas` keyed on `referenceNodeId`/scope. This pass is a
**fifth concurrent read** added to `getCanvas`'s existing `Promise.all` (alongside
interior nodes, interior edges, the boundary-proxy derivation, and the breadcrumb
CTE) — it keeps the read a single round trip (ADR-0001) and is a **bounded service
pass, never a widening of the recursive `endpoint_walk`/breadcrumb CTE**. The CTE
is single-project by construction; `parentId` cannot cross the seam (ADR-0041 §7),
so a recursive walk physically cannot resolve a foreign endpoint. The cross-project
pass is the correct tool precisely because it does **not** try to.

The foreign end renders through the **exact ADR-0031 per-edge boundary-proxy
machinery**, reused unchanged: a synthetic `nodeId` (an `xproxy_`-prefixed id, so
it never collides with an intra-project `proxy_<edgeId>` id), `realEndpointId =
foreignNodeId`, and a **derived identity** (`title`/`kind` read **live** from the
foreign Node across the seam). Its per-scope placement is the existing
`BoundaryProxyPlacement` table keyed `(containerNodeId, realEndpointId)`
(ADR-0036), unchanged. The proxy is **marked "From [Foreign Project]"** using the
foreign project's **display title — never its slug** (ADR-0002: the
capability-URL slug is a bearer secret and leaks nowhere; ADR-0041 §5 names the
foreign **title** for the same reason).

### 5. Plain foreign columns → a dangling reference renders "proxy absent," never a broken node

Because `foreignProjectId`/`foreignNodeId` are **plain columns, not FKs** (§1), the
foreign Node can be soft-deleted, removed, or made unreadable while the
`CrossProjectEdge` row survives. The render handles each the same way: if the
foreign end is **not live** — denied by the per-actor re-gate (§3), soft-deleted,
or a dangling reference whose target no longer exists — the derivation emits
**nothing** for that row. The proxy is **absent**; there is **no broken node, no
error surface, no disclosure**. This is the **same posture ADR-0031 already takes
for a soft-deleted endpoint** (an `Edge` with a dead endpoint hides the
Connection), carried **across the project seam**. The row **survives** the dangle —
garbage-collecting or sweeping dangling rows is **#123**, not this slice.

### 6. The link carries its own Interaction; the label is untrusted

A `CrossProjectEdge` carries its **own `interaction`** (ADR-0027: a Connection
carries its own Interaction, defaulting to `ASSOCIATION`) and an optional `label`.
The `label` is **untrusted user content — stored verbatim, never interpreted**
(the prompt-injection standing note), exactly as an `Edge` label is.

### 7. Scope: create + render only; delete/restore/dedup/Go-to/export are #123

This slice is **create + render only**. The following are the **explicit seam**
between this slice and **#123**, and a reviewer should **not** flag their absence
as a gap in this ADR:

- **Delete / restore.** A `deletionId` column is **present but unwired** — there
  is no cross-project delete/restore in this slice. The column is the forward
  hook; its non-use is intentional.
- **Cross-project dedup index.** There is **no** partial unique index on
  `CrossProjectEdge` this slice — the `Edge` indexes (ADR-0010) are deliberately
  untouched and **no analogue is added** here. Cross-project de-dupe is #123.
- **Cross-boundary "Go to."** The foreign proxy has **no** "descend to real
  endpoint" navigation across the seam this slice — it is a passive marker only.
- **Export markers.** The markdown export (ADR-0017) is **untouched**: it does not
  yet emit cross-project link markers, so no fixture changes and the **golden file
  stays byte-stable** this slice.

## Consequences

- **Reviewable invariant — a separate table, never an `Edge` column.** The
  cross-project link is a `CrossProjectEdge` row. A reviewer proposing a
  foreign-pointing column on `Edge`, or routing the link through `connectNodes`,
  regresses this ADR — and forces a change to the `Edge` dedup indexes and the
  ancestry CTE that this design exists to avoid.
- **Reviewable invariant — the `Edge` dedup indexes and the single-project CTE are
  byte-unchanged.** `idx_edge_dedup`/`idx_edge_assoc_dedup` (ADR-0010) and the
  `endpoint_walk` ancestry CTE (ADR-0031/0006) are untouched by this slice. Any
  diff to them is a regression of the separation this ADR is built on.
- **Reviewable invariant — ADR-0028 holds literally.** "No `Edge` spans a project"
  is still true to the letter, because the cross-project row is **not** an `Edge`.
  A foreign `projectId` reaching the `Edge` table regresses both this ADR and
  ADR-0028.
- **Reviewable invariant — host-anchored; absent from the foreign standalone
  read.** Nothing is written to the foreign graph; the foreign project viewed
  directly never shows the link. Surfacing it on the foreign standalone read
  regresses §2 — and would mean a `view`-only actor's project sprouting an edge it
  never authored.
- **Reviewable invariant — foreign FK columns would be a cascade hazard; they are
  plain by design.** `foreignProjectId`/`foreignNodeId` are plain columns, not
  FKs, so a foreign delete **never** cascades into the host graph (the hazard
  ADR-0041's `SetNull` avoided). Promoting them to cross-project FKs regresses this
  ADR. The consequence — a dangling reference — is handled as "proxy absent" (§5),
  not prevented by a cascade.
- **Reviewable invariant — host `edit` first, then foreign `≥ view`, per-actor on
  every read.** Create gates host-edit before resolving anything foreign
  (non-disclosing `Forbidden`), then foreign `≥ view` (`none → NotFound`); the
  foreign capability is re-resolved on **every** read, never stamped. A
  host-capability shortcut to foreign content is a cross-project privilege leak and
  a regression (ADR-0041 §3). A revoked foreign grant makes the proxy vanish with
  **no write**.
- **Reviewable invariant — render is a bounded pass, not the CTE.** The foreign end
  is derived by a dedicated, bounded fifth concurrent read in `getCanvas`'s
  `Promise.all` (ADR-0001), **never** by widening the recursive
  `endpoint_walk`/breadcrumb CTE. A `parentId` walk across the project seam is
  impossible (ADR-0041 §7) and any attempt to make the CTE cross it regresses this
  ADR.
- **Reviewable invariant — reuses the frozen proxy + placement machinery.** The
  foreign end is an ADR-0031 boundary proxy (`realEndpointId = foreignNodeId`,
  derived `title`/`kind`, synthetic `xproxy_` id) placed by the existing
  `BoundaryProxyPlacement` table keyed `(containerNodeId, realEndpointId)`
  (ADR-0036). Inventing a parallel proxy or placement construct regresses the
  reuse.
- **Reviewable invariant — the foreign slug never leaks; the marker is the title.**
  The proxy is marked "From [Foreign Project]" with the foreign project's display
  **title**, never its capability-URL slug (ADR-0002 / ADR-0041 §5). Surfacing the
  slug anywhere — marker, response, log — regresses both this ADR and ADR-0002.
- **Reviewable invariant — plain foreign columns by design; dangling → absent.** A
  denied re-gate, a soft-deleted foreign Node, or a dangling reference renders
  "endpoint not live → proxy absent" (§5) — the cross-seam continuation of
  ADR-0031's soft-deleted-endpoint posture. The row survives the dangle; the GC
  sweep is #123. A broken node or an error surface for a dangle is a regression.
- **`pnpm check` cannot see any of this.** The host-edit-first/foreign-view-second
  ordering, the `none → NotFound` non-disclosure, the self/same-project reject, the
  per-actor revocation making the proxy vanish, the host-anchored absence from the
  foreign standalone read, and the dangling-reference "proxy absent" are all
  runtime/authorization behavior ESLint and `tsc` cannot assert. Their correctness
  rests on the Vitest service tests against real Postgres (ADR-0003): connect
  host→foreign you can read → ok; foreign you cannot read → `NotFound`; host `edit`
  missing → `Forbidden`; same-project/self → `ValidationError`; the proxy appears
  in the host-scope read; the link is **absent** from the foreign standalone read.
- **Forward seam — #123.** Delete/restore (the present-but-unwired `deletionId`),
  the cross-project dedup index, cross-boundary "Go to," and export markers
  (ADR-0017 golden file byte-stable this slice) are the explicit follow-on. A
  reviewer should not flag the absent dedup index or the unwired `deletionId` as an
  ADR-0043 gap — they are the named seam between this slice and #123.
