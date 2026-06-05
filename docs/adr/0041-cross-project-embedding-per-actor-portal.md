# 41. Cross-project embedding via a per-actor portal: a pointer, not a snapshot; an FK discriminator, not a NodeKind; a stay-on-host-URL scope path

## Status

Accepted (#119, the foundational tracer-bullet slice of Project Portals).

**Extends** [ADR-0040](0040-role-based-project-sharing.md): that ADR gave the
read seam two entry shapes — slug-keyed reads and id-keyed writes. A portal needs
a **third** corner: an _id-keyed read_, because a portal addresses its target by
internal `Project.id`, never by slug. `resolveReadableProjectById` is that fourth
cell of the seam matrix, sharing the one `resolveCapability` spine. **Extends**
[ADR-0002](0002-capability-url-sharing.md): non-disclosure now spans a **project
boundary** — a target you may not read is reported not-found through the portal,
exactly as a missing slug is. **Builds on** [ADR-0018](0018-nodekind-expanded-taxonomy-stays-cosmetic.md):
a portal is **behavioral**, so it is an FK, never a `NodeKind` value — kind stays
cosmetic. **Amends** [ADR-0040](0040-role-based-project-sharing.md) / [ADR-0031](0031-cross-scope-read-derivation-and-per-edge-boundary-proxy.md):
`getCanvas` no longer "gates once" per request — it gates **once per project
segment crossed**. **Relates to** [ADR-0007](0007-descent-route-and-breadcrumb-bar.md):
the `?via=` route param is an **inter-project routing fact**, not intra-project
ancestry — ancestry stays server-derived and is not regressed. **Preserves**
[ADR-0028](0028-cross-scope-connections-lineal-ingress.md): no `Edge` spans a
project; boundary proxies still derive within a single segment.

## Context

A Project is a closed graph today. You descend from its root through `parentId`
children to any depth (ADR-0007), and every Connection, breadcrumb, and boundary
proxy is interior to that one Project — which is exactly why `getCanvas` can gate
**once**, at the slug→project bind, and trust every scope beneath it (ADR-0040).
The product now needs a graph to **reference another whole Project**: drop an
"Embed a project" Component onto a Canvas, descend into it, and see the foreign
project's content rendered "inside" the host. This is the first construct that
**leaves the host graph**, and it forces four questions the single-project model
never had to answer.

- **What is the embed — a copy or a pointer?** The whole codebase derives rather
  than stores (Canvas has no id, breadcrumbs and boundary proxies are read-time
  CTEs, Trace is recomputed; ADR-0031). A snapshot of the target would be a stored
  duplicate that rots the instant the target changes.
- **Is "is a portal" a kind or a fact?** `NodeKind` is cosmetic by deliberate
  invariant (ADR-0018): it drives icon/colour/label and nothing behavioral. A
  portal _is_ behavioral — it changes what descending does — so encoding it as a
  `PORTAL` kind would be the exact "kind starts to mean something" regression
  ADR-0018 forbids.
- **Whose capability governs the foreign content?** The host's owner may have no
  grant at all on the target. Reusing the host's already-resolved capability
  (the "gate once" shortcut) would silently hand foreign reads to anyone who can
  read the host — a cross-project privilege leak.
- **What URL are you on while inside the embed, and can the foreign slug leak?**
  The capability-URL slug is a bearer secret (ADR-0002); surfacing the target's
  slug in the host's URL would disclose it to everyone who can read the host.

## Decision

### 1. A portal is a nullable FK, not a NodeKind

A **portal** is a `Node` carrying a nullable `embeddedProjectId` FK to
`Project.id` (`onDelete: SetNull`, indexed). **Presence of the FK is the sole
discriminator** — the Node keeps an ordinary cosmetic **kind** (ADR-0018 holds:
no `PORTAL` enum value is added, no kind gains behavior). This mirrors the
`sourceSpecId` provenance FK (ADR-0033): a nullable pointer whose presence flips
behavior, not a taxonomy value. `onDelete: SetNull` is the load-bearing choice —
deleting the **target** must never cascade into the **host** graph (a portal is
not a child of the thing it points at) and must never be **blocked** by an
inbound portal. When the target is deleted the FK nulls and the portal
**neutralizes** to a plain Component — degrade, never break, never orphan.

### 2. A live pointer, never a snapshot

The portal stores only the pointer; the embedded content is **always read live**
from the target Project at descent time. There is no copied subtree, no cached
foreign graph, no `embeddedAt` snapshot — the derived-not-stored posture that
governs Canvas, breadcrumbs, boundary proxies (ADR-0031), and Trace governs the
portal too. The target's current state is what a descent renders; an edit on the
target is visible through every portal that points at it on the next read.

### 3. A per-actor re-gate is the security model: `resolveReadableProjectById`

Descending through a portal re-resolves the **descending actor's own**
capability against the target via a new id-keyed read seam
`resolveReadableProjectById(db, actor, projectId)`. It mirrors the slug-keyed
`resolveReadableProject` (ADR-0040) but keys by internal id, shares the one
`resolveCapability` spine, and maps **`none → NotFoundError`** for non-disclosure
— a target you may not read is indistinguishable from one that does not exist. It
filters `deletedAt: null` (a soft-deleted target is not-found, not a stale read)
and **honors the target's own `guestAccess`** — the deliberate opposite of the
MCP token path, which forces `guestAccess: NONE` (ADR-0040 pin 1). The contrast
is principled, not an oversight, and is asserted in tests: a portal descent is a
**session actor following an in-app link the way a slug holder would**, so a
target at the default `guestAccess: VIEW` is readable through the portal exactly
as it is by slug; the MCP path force-`NONE` exists because a leaked _token_ must
not become a near-universal read key, a hazard the in-app portal does not carry.

**The host's capability NEVER governs foreign content.** A host owner with no
grant on the target sees a **locked portal** — identical, by the `none →
NotFound` mapping, to a missing scope. This is the headline non-disclosure
invariant and the headline test.

### 4. `createEmbeddedComponent`: host-edit first, then target-view

Creating a portal gates **in order**, and the order is load-bearing for
disclosure:

1. **Host `edit`** — `authorizeProjectWrite(host, "edit")` runs **first**; a
   caller who cannot edit the host gets `ForbiddenError` and never learns whether
   the target exists.
2. **Target `≥ view`** — only then is the target re-gated via
   `resolveReadableProjectById`; you may embed **only what you can read**. A
   target you cannot read collapses to `NotFoundError`.

Self-embed (a project pointing at itself) is rejected with `ValidationError`.
Embed-stack depth is capped at `ANCESTRY_DEPTH_CAP` (256) — the same fuse the
breadcrumb and boundary walks share (ADR-0006/0031), reused, not re-invented.
**The picker is owned-only this slice**: `listReferenceableProjects` (over
`listProjectsForActor`, excluding the current project) offers only projects the
actor **owns**. Widening to shared targets is additive and is the next slice —
the re-gate already honors membership, so widening the picker changes no
authorization, only what the picker surfaces.

### 5. `getCanvas` takes a crossing stack; the URL stays on the host slug

`getCanvas` generalizes from a single host scope to a **crossing stack**: a new
`embedPath` input is the ordered list of **portal Node ids** crossed, host-first.
The route carries it as a typed `?via=` query param. The URL **stays under the
host slug** for the entire descent — `/p/[hostSlug]/n/[nodeId]?via=…` — and the
**target's slug is never exposed** in the path, the query, or any response. A
**forged or stale `via`** chain — a portal id that does not resolve, a target the
actor may no longer read, an entry that is not actually a portal — collapses to
`NotFoundError` at the re-gate. The client chain is **wholly untrusted**.

> **Disambiguation — two unrelated things both spelled `via`.** The `?via=`
> route param introduced here is the **portal crossing-stack**: an untrusted,
> client-supplied list of portal Node ids that is **re-gated per crossing** and
> decides which foreign segment renders. It is entirely distinct from the
> reserved **`Actor.via`** field (`"session" | "token"`, ADR-0021/0040), which
> records _how an actor authenticated_ and — like `scopes` — **never decides an
> authorization outcome**. The `?via=` chain decides _what to render after
> re-gating_, never _whether_ to render; authorization still derives solely from
> the actor's `userId` capability on each crossed project. Do not let the shared
> spelling suggest a shared trust model: `Actor.via` is a trusted provenance
> label that grants nothing, and `?via=` is an untrusted routing input that is
> verified, not trusted, at every step.

### 6. Authorization gates once per project segment crossed

The ADR-0040 "gate once" rule is **amended, not broken**: it gated once because
a Project is a closed graph and one gate covered every interior scope, breadcrumb
ancestor, and boundary proxy. That guarantee holds **within a segment** — a
maximal run of scopes inside one Project. A portal crossing enters a **new**
project, so a new gate is required. The rule becomes: **gate once per project
segment crossed.** The host gate runs at the root; each entry in `embedPath`
re-runs `resolveReadableProjectById` for the **descending actor** against the
next target. N portals crossed means N+1 gates, each `none → NotFound`. There is
still **no per-node authz** — the gate is per _segment_, not per scope.

### 7. Breadcrumbs are a per-segment CTE concatenation, spliced at portal markers

The breadcrumb trail spans the boundary as a **per-segment concatenation**: each
project segment computes its own ADR-0006 recursive-CTE trail
(`root → … → portal` within that project), and the segments are spliced together
at the **portal markers**. There is **no cross-project CTE** — `parentId` cannot
cross a project boundary (the portal is not a `parentId` child of the target's
root), so a single recursive query physically cannot walk across the seam. The
spine reads host trail → portal marker → foreign trail → (next portal marker →
…), assembled in the service from per-segment CTE results, never from one walk.

### 8. No Edge spans a project; proxies stay within a segment

[ADR-0028](0028-cross-scope-connections-lineal-ingress.md) is **preserved
intact**: a Connection still links two Components, and the portal is **not** a
Connection — it is a Node with an FK, never an Edge. No `Edge` row references a
foreign project, and the cross-scope read derivation (ADR-0031) computes boundary
proxies **within a single segment only**. Cross-project dependency surfacing — a
boundary proxy that reaches _through_ a portal — is explicitly **not** in this
slice; the seam is clean, and a future ADR may revisit it without unwinding this
one.

## Consequences

- **Reviewable invariant — FK, not kind.** "Is this a portal" is
  `embeddedProjectId != null`, never a `NodeKind` value. A reviewer proposing a
  `PORTAL` kind, a kind-gated branch, or any behavior keyed on kind regresses
  this ADR **and** ADR-0018. The cosmetic-kind invariant is unbroken.
- **Reviewable invariant — the foreign slug never leaks.** The target is
  addressed only by internal `Project.id` via `embeddedProjectId`; its
  capability-URL slug appears in no path, query, response, breadcrumb, or log.
  Surfacing it anywhere regresses both this ADR and ADR-0002.
- **Reviewable invariant — every crossing re-gates, `none → NotFound`.** No
  descent trusts the client `?via=` chain; each crossed segment re-resolves the
  descending actor's capability and maps a denial to not-found. A host-capability
  shortcut across the boundary is a cross-project privilege leak and a regression.
- **Reviewable invariant — `via` is the crossing-stack, not ancestry.** Intra-
  project ancestors stay server-derived (ADR-0007); `?via=` carries only the
  inter-project portal hops. Conflating the two — deriving ancestry from `?via=`,
  or persisting `?via=` as ancestry — regresses both ADRs. And `?via=` is never
  the reserved `Actor.via` (§5 disambiguation): one is an untrusted routing input,
  the other an inert provenance label.
- **Reviewable invariant — `resolveReadableProjectById` is the id-keyed read
  corner that honors `guestAccess`.** It is the fourth seam cell (ADR-0040), and
  its honoring of the target's `guestAccess` (vs the MCP path's force-`NONE`) is
  deliberate and tested. A reviewer "tightening" it to force `NONE`, or loosening
  the MCP path to match it, must do so by ADR, not by reflex — the two diverge for
  a reason (§3).
- **Reviewable invariant — `SetNull` neutralizes, never cascades.** Deleting a
  target nulls inbound `embeddedProjectId` FKs and degrades those portals to
  plain Components; it never deletes host nodes and is never blocked by an inbound
  portal.
- **Reviewable invariant — pointer, not snapshot.** No stored copy of the target
  graph exists; the embed is read live. A proposal to cache or snapshot the
  foreign subtree regresses the derived-not-stored posture (ADR-0031) this ADR
  shares.
- **`pnpm check` cannot see the non-disclosure rule.** The `none → NotFound`
  collapse, the per-segment re-gate, the host-owner-without-grant locked portal,
  and the forged-`via` rejection are all runtime/authorization behavior that
  ESLint and `tsc` cannot assert. Their correctness rests on the Vitest service
  tests against real Postgres (ADR-0003) — embed an owned target succeeds; target
  lacking `view` → NotFound; host `edit` missing → Forbidden; descent through a
  readable embed returns the foreign interior; and the headline **host owner with
  no foreign grant → NotFound locked portal**.
- **Forward flag (not designed here):** deeper **markdown export through portals**
  is deferred to **#123**, which will touch the markdown serializer and
  `llms.txt` (ADR-0017). This slice leaves ADR-0017 **untouched** — the export
  does not yet follow a portal into its target, so no fixture changes and the
  golden file is byte-stable. A reviewer should not flag the export's
  portal-blindness as an ADR-0041 gap; it is the explicit seam between this slice
  and #123.
