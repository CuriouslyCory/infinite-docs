# 42. A portal node has no host interior; children attach to the foreign root only — edit-through re-authorizes against the active foreign project, and the foreign capability (never the host's) governs `canEdit`

## Status

Accepted (#121, the third Project Portals slice — read-only descent (#119) and
the host-read access-state tiers (#120) precede it).

**Extends** [ADR-0041](0041-cross-project-embedding-per-actor-portal.md): #119
made portal descent **read-only this slice**; #120 resolved the per-actor
**Portal access state** tiers (`enterable` / `read-only` / `locked`) on the host
read. This ADR turns the `enterable` tier into an actual **edit-through** — an
actor holding ≥ `edit` on the embedded project mutates its interior through the
portal, persisting to that project standalone — and supersedes the
"read-only-this-slice" qualifier for that tier. **Builds on**
[ADR-0001](0001-service-layer-db-actor-input.md): edit-through introduces **no
new write authorization** — every graph mutation already gates through the
id-keyed write seam `authorizeProjectWrite(db, actor, node.projectId, "edit")`,
and for a Node living in the embedded graph `node.projectId` **is** the foreign
project, so the existing seam re-authorizes against the foreign project with no
new code. **Composes with** [ADR-0024](0024-movenode-reparent-reject-orphaning.md):
the **portal-interior guard** is a new reparent/parent precondition that sits
**before** ADR-0024's cycle (`ValidationError`) and orphan (`ConflictError`)
rejects and is orthogonal to both. **Preserves** [ADR-0018](0018-nodekind-expanded-taxonomy-stays-cosmetic.md):
the guard keys on the **FK discriminator** (`embeddedProjectId != null`), never
on `kind` — kind stays cosmetic. **Relates to**
[ADR-0040](0040-role-based-project-sharing.md): the `canEdit` the descended
client renders is derived from the **active (foreign) project's** capability,
presentation only — the service-layer write gate remains the sole authorization
(the viewer-mode-is-presentation invariant).

## Context

ADR-0041 built the portal as a per-actor re-gated **read**: descend through a
portal, re-resolve the descending actor's capability against the target via
`resolveReadableProjectById` (`none → NotFound`), and render the foreign interior
live. The descent was deliberately **read-only in that slice** even for an actor
who holds `edit` on the target — the slice proved the read seam and the
non-disclosing access-state tiers (#120) before admitting writes. The
`enterable` tier was defined (target capability ≥ `edit`) precisely so this slice
could light it up.

Three questions decide the shape of edit-through.

- **Does editing through a portal need new write authorization?** A portal
  crosses a project boundary, and the host's capability never governs foreign
  content (ADR-0041 §3). It would be easy to assume a fresh "may this actor edit
  through this portal" check is required. But every graph mutation in the service
  layer already authorizes against the project that **owns the Node being
  mutated** — `authorizeProjectWrite(db, actor, node.projectId, "edit")` — and a
  Node in the embedded graph carries the **foreign** `projectId`. The question is
  whether that existing seam already carries cross-boundary writes, or whether the
  boundary demands a new gate.

- **What governs `canEdit` for a descended actor — the host or the target?** The
  client renders an edit surface or a read-only surface off a `canEdit` flag. For
  intra-project scopes that flag came from the one host gate (ADR-0040). Across a
  portal, reusing the host's capability would let a host editor with no foreign
  grant _appear_ able to edit foreign content (and conversely starve a foreign
  editor who is only a host viewer) — the exact cross-project capability confusion
  ADR-0041 forbids. `canEdit` must track the **active foreign project**.

- **Where do `parentId` children of a portal go?** A portal's interior is reached
  by descent + re-gate into the foreign root, never by a `parentId` walk
  (ADR-0041 §7: `parentId` cannot cross a project boundary). So a portal **has no
  host interior** — there is no host-side Canvas under it to add Components to. A
  `createNode` or `moveNode` that resolved a portal as its parent would attach a
  **host-graph** Node beneath a node whose "inside" is a foreign root, fabricating
  a host interior that the descent model says does not exist and bleeding the two
  graphs into each other. This needs an explicit rule.

## Decision

### 1. Edit-through re-authorizes against the active foreign project — the existing write seam carries it, no new authz

Mutating the interior of an embedded project through a portal is **not** a new
operation and needs **no new authorization path**. Every graph write
(`createNode`, `moveNode`, `updateNode`, `updateNodeKind`,
`updateNodeDocumentation`, `updatePositions`, `connectNodes`, `updateEdge*`,
`deleteNode`, `restoreNode`) already gates through
`authorizeProjectWrite(db, actor, node.projectId, "edit")` (ADR-0001), and for a
Node that lives in the **embedded** graph `node.projectId` **is the foreign
project's id**. So the seam already:

1. loads the **foreign** project by id,
2. resolves the **descending actor's own** capability on it (owner identity +
   foreign `ProjectMembership` role + foreign `guestAccess`), and
3. `requireCapability(cap, "edit")` — `ForbiddenError` for a `view`-only actor, a
   successful mutation for an `edit`/`admin`/`owner` actor.

This is the same "gate once per project segment crossed" rule ADR-0041 §6
established for reads, observed to **already hold for writes** because writes are
keyed by the internal `projectId` of the row, which is the foreign project for
foreign content. An **EDITOR/owner of the target** adds, renames, re-kinds,
re-documents, repositions, connects, deletes, and reparents inside the foreign
interior, and it **persists to that project standalone** — open the target
directly and the change is there (it is one graph, addressed two ways). A
**VIEWER of the target** attempting any write gets `Forbidden` from this same
seam, regardless of what the descended client renders. The honesty banner (§4)
keeps the actor oriented; the seam keeps them honest.

The host's capability is **irrelevant** to a foreign mutation: the write loads
the foreign project, not the host. A host owner with no foreign grant cannot even
descend (`locked`, ADR-0041 §3), let alone write; a host viewer who is a foreign
editor writes freely. Capability follows the **content's** project, never the
URL's host slug.

### 2. The active foreign project's capability governs `canEdit` when descended — presentation, not authorization

`getCanvas` already walks the portal stack re-gating each crossing
(`resolveReadableProjectById`) and computes the **active project** (the innermost
embedded project after a non-empty `embedPath`, else the host; ADR-0041 §5). This
ADR surfaces that active project's `viewerCapability` as a **`canEdit`** boolean
on the `getCanvas` response, so the descended client renders the edit surface for
an `enterable` descent (foreign capability ≥ `edit`) and the **viewer** read-only
surface for a `read-only` descent (foreign capability = `view`). `canEdit` is
**derived from the active (foreign) project, never the host** — the headline of
this decision and a regression if reversed.

`canEdit` is **presentation, not authorization** (ADR-0040): it decides what the
client _draws_, never what the service _permits_. The service-layer write gate
(§1) is the authorization and is re-checked on every mutation, so a client that
mis-renders an edit affordance for a viewer still has every write denied at the
seam. Hiding affordances is courtesy; the seam is the wall.

**This is not a disclosure.** Surfacing the foreign capability to a descended
actor reveals nothing they could not already infer: to descend at all they passed
the `≥ view` re-gate and are reading the foreign interior live (titles, docs,
Connections). "You may also edit here" is a property of a grant they already
hold over a scope they already read — not a new secret. Edit-through exists only
**past** a successful `≥ view` re-gate, so the `locked` tier (host owner without a
foreign grant) never reaches it and the headline non-disclosure invariant of
ADR-0041 (locked portal indistinguishable from a missing scope) is untouched.

### 3. The portal-interior guard: a portal has no host interior; `createNode`/`moveNode` reject a portal parent with `ValidationError`

A **portal has no host interior** — its interior _is_ the foreign root, reached
by descent + re-gate, never by a `parentId` child (ADR-0041 §7). Therefore
`createNode` and `moveNode` **reject any resolved parent whose
`embeddedProjectId != null`** with a `ValidationError` ("A portal Component has no
host interior; its interior is the embedded project's root"). The semantic is
ADR-0024's `ValidationError` register: the request is malformed for _this_
parent — no state change makes attaching a host child under a portal valid, so
the agent must not retry with the same parent.

This composes with ADR-0024 by **extension, not modification**. Both
`createNode` and `moveNode` already resolve the parent with a project-scoped
`findFirst` (today selecting `{ id }`); the guard adds `embeddedProjectId` to that
**same select** and rejects when non-null, as a **precondition evaluated before**
ADR-0024's subtree cycle walk (`ValidationError`) and incident-edge orphan check
(`ConflictError`). It is orthogonal to both — a portal parent is rejected
structurally irrespective of subtree shape or incident edges — so no ordering
hazard exists. It strengthens ADR-0024's "the new parent must live in the moved
Node's project" with "…and must not itself be a portal."

The guard is a **behavioral rule on the FK discriminator** (`embeddedProjectId !=
null`), **never on `kind`** — a portal keeps an ordinary cosmetic kind (ADR-0018,
ADR-0041 §1). A reviewer who proposes keying this on a `PORTAL` kind regresses
both ADRs. The batch applier (`apply-graph`) shares `createNode`'s
parent-resolution posture; the guard must hold there too if it resolves a parent
independently, or the cross-graph attach reopens through the batch door
(out of scope for #121's named tests, but flagged so the seam is not silently
left open).

### 4. The honesty banner is a UX consequence of cross-boundary editing

When the active scope was reached **through a portal** (`embedPath` non-empty), a
descended editor sees a persistent **"Editing embedded project: B"** banner (B
the active embedded project's display **title** — never its slug, ADR-0002 /
ADR-0041 §5). The banner exists because edit-through makes foreign mutations
indistinguishable, _at the point of editing_, from host edits — same URL (the host
slug, ADR-0041 §5), same Canvas chrome. Without the banner an editor could rename
or delete in B believing they are editing the host A. The banner is the **honesty
seam**: it names which project the edits land in, so a mutation is never a
surprise. It renders only on the `enterable` (edit-through) descent; a `read-only`
descent already shows the **viewer** "View only" surface, and a `locked` portal
never descends.

## Consequences

- **Reviewable invariant — edit-through adds no new write authz.** Cross-boundary
  writes ride `authorizeProjectWrite(db, actor, node.projectId, "edit")` against
  the **foreign** `projectId` of the mutated Node. A reviewer proposing a new
  "portal write" gate, or a host-keyed write check, both regress this ADR — the
  existing per-project seam already carries it, and a host-keyed check would be a
  cross-project privilege leak (ADR-0041 §3).

- **Reviewable invariant — `canEdit` is derived from the active foreign
  project, and is presentation only.** The descended client's edit surface tracks
  the **active project's** `viewerCapability`, never the host's. Deriving
  `canEdit` from the host regresses ADR-0041 §3; trusting `canEdit` _as_
  authorization (skipping the service write gate) regresses ADR-0040 and ADR-0001.
  The flag draws; the seam permits.

- **Reviewable invariant — a portal has no host interior.** `createNode` and
  `moveNode` reject a parent with `embeddedProjectId != null` (`ValidationError`),
  on the FK discriminator, never on `kind`. A host child under a portal would
  fabricate a host interior the descent model denies (ADR-0041 §7) and bleed the
  host and foreign graphs together. Keying this on a `PORTAL` kind regresses
  ADR-0018 and ADR-0041 §1.

- **Reviewable invariant — the guard composes with ADR-0024 by extension.** It is
  a parent precondition evaluated **before** the cycle walk and orphan check, in
  the `ValidationError` register, orthogonal to both. It does not alter, reorder,
  or weaken either existing reject; rejected moves/creates still write nothing
  (the lone-update / no-cascade posture of ADR-0024 is intact).

- **Reviewable invariant — surfacing the foreign capability is not a
  disclosure.** Edit-through and `canEdit` exist only past the `≥ view` re-gate;
  the `locked` tier never reaches them, so ADR-0041's headline non-disclosure
  (locked portal ≡ missing scope) is untouched. The foreign **slug** is still
  never exposed; the banner names the foreign **title** only (ADR-0002 / ADR-0041
  §5).

- **The honesty banner is load-bearing UX, not decoration.** It is the only signal
  distinguishing a foreign edit from a host edit at the moment of editing (same
  URL, same chrome). Removing it lets an editor mutate B believing it is A — a
  correctness-of-intent regression even though authorization is unaffected.

- **`pnpm check` cannot see any of this.** Edit-through's foreign re-authorization,
  the viewer-Forbidden, the portal-interior `ValidationError`, and the
  foreign-derived `canEdit` are all runtime/authorization behavior ESLint and
  `tsc` cannot assert. Their correctness rests on the Vitest service tests against
  real Postgres (ADR-0003): child under a portal → `ValidationError`; move onto a
  portal → `ValidationError`; **EDITOR-on-target** create on the foreign interior
  → succeeds and is visible opening the target directly; **VIEWER-on-target** write
  through the portal → `Forbidden`; host editor without a foreign grant cannot
  descend, let alone write (the §3 / ADR-0041 lock holds under write).

- **Forward seam — cross-project moves stay rejected.** ADR-0024's "the new parent
  must live in the moved Node's project" is unchanged: `moveNode` still cannot
  reparent a Node _across_ a project boundary (the parent is project-scoped in the
  lookup). Edit-through edits a foreign interior **in place**; it does not let a
  Node migrate between the host and the embedded graph. A future "lift a Component
  through a portal" gesture, if ever wanted, is a separate ADR.
