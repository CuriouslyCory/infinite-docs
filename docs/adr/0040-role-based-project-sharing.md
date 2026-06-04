# 40. Role-based Project sharing: a capability ladder layered atop capability-URL reads

## Status

Accepted (#104).

## Context

ADR-0002 gave a **Project** exactly two access levels: the owner (writes) and anyone
holding the **capability-URL slug** (reads). That model deliberately shipped no roles,
no sharing table, and no invitations — "richer collaboration, if ever needed, is a later,
separate decision." This is that decision.

The product now needs a Project to be shared with **named users at differing levels** —
a teammate who may edit, a reviewer who may only view, a lead who may also manage who else
has access — without surrendering the convenience that made link-sharing the default. Three
constraints shape the design:

- **The owner stays the root of trust.** ADR-0002's `actor.userId === project.ownerId`
  identity check is the one grant that can never be revoked from inside the system. Roles are
  delegations _the owner authorizes_; no role may ever equal or exceed the owner, and the
  owner is not a row in the grant table that a bug could delete.
- **Reads must stay link-reachable without a session.** ADR-0002's slug-possession read grant
  is load-bearing for the convenience philosophy ("all links are share links by default"). A
  roles model must not turn every read into a sign-in wall.
- **Authorization still derives only from `userId`.** ADR-0001 and ADR-0021 are emphatic:
  `via`/`scopes` never decide an authz outcome, and a stored capability label is not an
  enforced one until an `access`-module change deliberately makes it so. A `Role` column must
  not silently become a second, parallel authz spine.

We also need the model to be **expressible as a single comparison** at the `access` seam, so
that the two existing authorization predicates (`assertCanRead`, `assertCanWrite`) generalize
rather than fork into a web of per-role branches.

## Decision

### A capability ladder of integer ranks

Authorization is decided by comparing two ranks on a single totally-ordered ladder:

```
none(0) < view(1) < edit(2) < admin(3) < owner(4)
```

A **capability** is the verb-level grant a caller has on a Project. `access` resolves the
caller's **effective capability** (the maximum of every grant that applies to them — owner
identity, membership role, or guest access) to an integer rank, and every gate is a single
`rank >= required` comparison. Reads require `view`; graph writes require `edit`; access-
management gates require `admin`; destroying or transferring the Project requires `owner`. The
ranks are an internal ordering, **not** a stored enum the way `NodeKind` is — they exist so the
ladder is comparable, not so they leak onto the wire.

The single pure resolver is `resolveCapability(actor, { ownerId, guestAccess }, membership)`
in `access.ts`: DB-free, operating over already-loaded facts, owner checked first. The DB-aware
seams in `access-db.ts` do the one membership-aware load and then call it; `requireCapability(cap, min)`
is the sole gate. This generalizes ADR-0002 without contradicting it: owner identity resolves to
`owner(4)` and a valid capability-slug under `guestAccess=VIEW` resolves to `view(1)`, which is
exactly the old two-level model expressed on the new ladder.

### Owner as the irrevocable root of trust

The **owner** (`project.ownerId`, ADR-0002) is the apex of the ladder and is **not** represented
as a membership row. It is the one grant resolved by identity comparison, checked **first and
unconditionally**, so it cannot be revoked, downgraded, or deleted by any access-management
operation — a `ProjectMembership` table corruption can strip every delegated grant but can never
orphan a Project from its owner, and an owner with a stray membership row is never demoted. Every
delegated capability (`view`/`edit`/`admin`) is strictly below `owner`; no member can grant a
capability they do not themselves hold, and no member can act on the owner's row. A migration or
service must **never** auto-insert an owner membership. Project deletion and any future ownership
transfer require `owner` rank, i.e. the identity check — never `admin`.

### Members and Roles

A **Member** is a User who has been granted a **Role** on a Project via a `ProjectMembership`
row (`{ projectId, userId, role }`, unique on `(projectId, userId)`). A **Role** is one of three
named, persisted levels that map onto the ladder via an exhaustive `Record<ProjectRole, Capability>`
(a future role is a compile error until mapped):

- `VIEWER` → `view` (read + **descend** into interior Canvases)
- `EDITOR` → `view` + `edit` (mutate the graph)
- `ADMIN` → `edit` + **manage access** (invite, change roles, set guest access) — but still
  strictly below `owner`: an ADMIN cannot delete or transfer the Project, nor touch the owner.

`Role` is the enum that names the rungs a human is assigned to; the ladder rank is what `access`
compares. They are kept distinct on purpose — `Role` is the wire/DB vocabulary (three values,
because there is no assignable "owner role" and no assignable "none role"), and the rank is the
internal total order the predicate uses.

### Guest access: the slug grant becomes a per-Project dial

A Project carries a **guest access** level — the capability granted to an _anonymous_ holder of
the **capability-URL slug**:

- `NONE` → no anonymous access; the slug alone resolves a not-found (ADR-0002's non-disclosure
  posture) and reads require a Member.
- `VIEW` → anonymous read + descend — **exactly today's ADR-0002 behavior**, and the **default**
  for every Project (new and existing, via a `NOT NULL DEFAULT 'VIEW'` backfill).

This is the seam where roles **layer atop** the capability-URL model rather than replacing it.
With `guestAccess = VIEW` (the default), an anonymous slug holder resolves to `view(1)` precisely
as ADR-0002 specifies — the capability-URL read grant is preserved unchanged, and the existing
**viewer** surfaces (read-only mode, "View only" badge, issue #16) are what a guest sees.
`guestAccess = NONE` is the new, opt-in lockdown that turns a Project from "link-readable by
anyone" into "members only" without changing the slug or any other grant. Guest access never
exceeds `view`; the slug is still **never** a write grant (ADR-0002), now stated as a ceiling on
the ladder rather than a special case.

### Invites: role-bearing bearer links, hashed at rest

An **Invite** (`ProjectInvite`) is a bearer link that grants a **Role** to whoever redeems it
while signed in, creating (or upgrading) their `ProjectMembership`. It is the system's third
bearer secret after the slug and the **API token**, and it inherits the API token's storage
posture wholesale (ADR-0020): the raw invite token is CSPRNG entropy shown **once**, stored only
as a **keyed HMAC** (`tokenHash`, unique for lookup-by-hash; same pepper machinery via
`keyVersion`), with a non-secret prefix for display, an expiry, and soft revocation. It is
project-scoped (no `userId` — an invite is consumed by _whoever_ redeems it). An Invite carries a
`Role`, never a raw rank, and never `owner` — you cannot invite someone to own the Project.
Redemption is the _only_ way an Invite confers anything: holding the link is not itself a grant
the way slug-possession is for guest reads; you must redeem it into a membership, so revoking the
Invite or the membership cleanly removes access.

The `ProjectInvite` **table** lands in this slice (ahead of its #106 redemption consumer) so the
full sharing data model arrives in one migration; the redemption _service_ is a later slice.

### Two authorization seams: slug-keyed reads vs id-keyed writes

The model has **two distinct entry shapes**, and the distinction is deliberate:

- **Reads are slug-keyed and non-disclosing.** The public read path resolves a Project _by slug_
  (`getProjectBySlug`, ADR-0002) and may have **no Actor at all** (anonymous guest). `access`
  resolves the effective read capability from `{ guestAccess, optional membership }` and gates on
  `view`. A denial (`cap < view`) is mapped to **`NotFoundError`** at the read seam
  (`resolveReadableProject`/`authorizeProjectRead`), never `ForbiddenError`, so a
  `guestAccess=NONE` project you are not a member of is indistinguishable from a missing one. The
  membership query is skipped entirely when the Actor is null (an anon can only ever reach guest
  capability), so the hot capability-URL path pays no join cost.
- **Writes are id-keyed and may disclose Forbidden.** Every mutation resolves the Project _by id_
  from an authenticated **Actor** (ADR-0001's `(db, actor, input)`), and `access` resolves the
  effective write capability from owner identity + membership role and gates on
  `edit`/`admin`/`owner`. A write denial surfaces **`ForbiddenError`** — the caller already holds
  the internal handle, so the denial leaks nothing new. A write is **never** authorized by slug
  possession (ADR-0002), so the write seam never keys on the slug.

Both seams funnel through the **one** pure `resolveCapability`, so the policy is single-sourced;
they differ only in lookup key (slug vs id), minimum capability, and deny-mapping (NotFound vs
Forbidden). `getCanvas` gates once at the slug→project bind — authorization is project-scoped, so
that single gate covers every descent scope, every breadcrumb ancestor, and every boundary proxy
(all interior to the same Project; ADR-0031), with no per-node authz.

### The MCP read path stays owner-only in this slice

The bearer-token MCP read paths (`exportMarkdownForActor`, `getTraceMarkdownForActor`) are
deliberately **NOT** routed through the capability ladder here. They keep their owner-only
`assertCanRead` (ADR-0022): a token actor reads only its own projects, never via the public guest
grant and not (yet) via membership. This keeps #104 behavior-identical for MCP. Member parity on
the MCP surface is a later slice (#109). API-token management (`token.service`) likewise stays
owner-only.

### Reaffirming ADR-0021: ranks are enforced, scopes are not

This ADR introduces an enforcement ladder for **capabilities**; it does **not** change the status
of **API token scopes**. `Role`/guest-access ranks _are_ enforced at the `access` seam — that is
their whole purpose. **Token scopes remain stored-not-enforced** (ADR-0021): authorization still
derives from `userId` (now: the userId's effective capability on the Project), and `actor.scopes`
still never decides an outcome. An Actor minted from a token (`via: "token"`, ADR-0022) is
authorized exactly as the minting user would be, and its `scopes` array is still inert. Roles
answer "what may this _user_ do on this _Project_"; scopes remain a stored label on the token that
answers nothing yet. `ProjectRole` and token `scopes` are two different axes; the "never roles"
synonym-rejection in the Token-scopes glossary entry refers to scopes, not to `ProjectRole`.

## Consequences

- The two-level ADR-0002 model is now the bottom of a five-rung ladder. Owner identity =
  `owner(4)` and default `guestAccess = VIEW` = `view(1)` reproduce yesterday's behavior exactly,
  so the change is additive and **behavior-neutral**: every existing Project keeps "owner writes,
  link reads" until someone adds a Member, an Invite, or flips guest access to `NONE`. The
  `NOT NULL DEFAULT 'VIEW'` backfill stamps every existing row atomically.
- The **owner is unrevocable by construction** — it is an identity check, not a row — so no
  access-management bug can lock the owner out of their own Project. ADMIN is powerful but capped
  below owner; deletion and transfer are owner-only.
- `guestAccess = NONE` gives a one-flip "members only" Project without rotating the slug. Slug
  rotation/revocation (still deferred per ADR-0002) remains the separate answer to _disclosure_;
  guest access answers _policy_.
- Invites inherit the API-token security posture (ADR-0020) rather than inventing a new one: a DB
  dump yields no replayable invite, redemption is one `findUnique`, and revocation is soft and
  clean. A reviewer adding invite features must carry that posture (hash-at-rest, show-once,
  not-found-not-forbidden).
- The non-disclosure rule (ADR-0002) extends to the whole ladder: a slug under `guestAccess = NONE`
  you have no membership on is reported **not-found**, never forbidden — existence never leaks, for
  anonymous and logged-in non-members alike.
- ADR-0021 is reaffirmed, not amended: capability ranks are enforced; token scopes are not. The two
  systems must not be conflated — a future reader must not assume `actor.scopes` gained teeth
  because `Role` ranks did.
- The ladder is internal ordering, not a stored taxonomy (contrast `NodeKind`, ADR-0018). Adding a
  rung is an `access`-module change with an ADR, not a migration — but the assignable `Role` enum
  (three values) _is_ persisted, so widening it (e.g. a future `COMMENTER`) is a deliberate schema +
  ADR change, never an accident of a new rank existing.
