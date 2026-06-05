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

```text
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
full sharing data model arrives in one migration; the redemption _service_ (`claimInvite`, the
route `/i/[token]`) lands in **#106** — specified in the "Redemption protocol" section below.

### Redemption protocol (#106): race-safe, idempotent, non-disclosing

`claimInvite(db, actor, { token })` consumes an Invite into a `ProjectMembership`. It runs in **one
interactive transaction at the project default READ COMMITTED** — **SERIALIZABLE is explicitly
rejected** (it would force a `40001` retry loop for no benefit the guarded single-row writes do not
already give), and **no advisory lock** is used. Two primitives carry the concurrency correctness:

- **The `@@unique[projectId,userId]` index is the per-user serialization point.** Concurrent claims
  by the _same_ user contend on it: the loser blocks on the insert, then resolves against the
  now-present row.
- **A guarded cap `UPDATE` is the per-invite (maxUses) serialization point** — the same
  conditional-write TOCTOU idiom as `deleteProject`/`setGuestAccess`. Because Prisma cannot compare
  two columns, it is **raw SQL**: `UPDATE "ProjectInvite" SET "useCount" = "useCount" + 1 WHERE id =
… AND "revokedAt" IS NULL AND ("expiresAt" IS NULL OR "expiresAt" > now()) AND ("maxUses" IS NULL
OR "useCount" < "maxUses")`. Under READ COMMITTED a losing concurrent claim re-reads the committed
  row and matches **zero rows**; `consumed === 0` is the single failure signal.

The **ordering inside the txn is load-bearing** (the naive "increment then upsert" the issue body
sketched has a real per-user double-spend bug — one new user firing two claims would burn two uses):

1. **Lookup** the invite by `tokenHash` + the project's `slug`/`ownerId`/`deletedAt` + the actor's
   current membership role.
2. **Non-disclosure collapse** — missing token, soft-deleted project, revoked, expired, OR maxed all
   throw **one** `NotFoundError`; no body, no project disclosure (inherits `resolveActorFromToken`'s
   posture).
3. **Owner short-circuit** — the owner is identity, never a membership row; return success, **no use,
   no row**.
4. **Equal-or-higher member short-circuit** — a member already at/above the invite's rank is a no-op
   success; **no use, no write, never a downgrade**.
5. **Grant** — INSERT a new membership, or conditionally raise a strictly-lower role to
   `MAX(existing, invite.role)`. A grant that no-ops (a sibling claim already inserted / raised it,
   surfaced as a caught `@@unique` P2002 or a zero-count conditional raise) returns **without
   consuming a use** — making use-consumption single-valued per user.
6. **Consume one use ONLY on a real grant** via the guarded cap `UPDATE` **last**. `consumed === 0`
   throws `NotFoundError`, which **rolls back the whole txn including the speculative grant** —
   grant-before-consume is safe precisely because a maxed-loser's membership insert is undone.

**MAX-role is computed in TypeScript** over the capability ladder rank (`VIEWER < EDITOR < ADMIN`),
**never** a SQL `GREATEST` on the `ProjectRole` enum — the enum's Postgres text ordering is _not_ its
rank ordering. MAX is commutative and idempotent, so concurrent claims converge to the highest
granted role regardless of commit order and a re-claim never downgrades.

**Revoke ≠ remove.** Stamping `revokedAt` blocks all _future_ claims (the guard's `revokedAt IS NULL`
fails) but leaves every prior `ProjectMembership` intact — closing the door does not evict people
already through it. Removing an existing member is a distinct operation (#108), not a side effect of
revocation. Token-in-URL hygiene: `/i/[token]` sets `Referrer-Policy: no-referrer` (plus
`noindex`/`no-store`), redeems-then-redirects so the token-bearing URL is not a durable landing page,
and the raw token is never logged — only the `prefix` is loggable.

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

### The MCP read path: owner-only in #104, member-aware as of #109

**Superseded by #109 (the final slice of this epic).** #104 deliberately kept the bearer-token MCP
read paths (`exportMarkdownForActor`, `getTraceMarkdownForActor`) OFF the capability ladder — they
used an owner-only `assertCanRead`, so a token actor read only its own projects. #109 lifts that
exception: both read services now resolve through the **one** `resolveCapability` and gate on
`view`, so a token actor reads every project it **owns or is a member of**. `assertCanRead` is
deleted — there is one read-authz spine, not two.

Four pins make this safe and coherent (#109):

1. **`guestAccess` is forced to `NONE` on the token path.** A token is a userId-identified
   credential, never the anonymous slug-holder the guest grant was defined for, so it must NOT read
   a `guestAccess=VIEW` project it is not a member of. Both read services pass
   `resolveCapability(actor, { ownerId, guestAccess: "NONE" }, membership)`. This bounds a leaked
   token's blast radius to the minting user's own + member projects — without this, since `VIEW` is
   the default, a leaked token would be a near-universal read key.
2. **Enumeration equals the read grant.** `resources/list` enumerates owner-or-member projects via
   the new `listProjectsForActor` (the owner-only web `listProjects` is deliberately left untouched
   so the dashboard's owner-gated per-card delete button stays coherent). A token reads exactly what
   it can enumerate — no invisible, un-discoverable read surface.
3. **Deny → `NotFoundError` (non-disclosure).** A non-member (and a guest-VIEW non-member, per pin 1)
   resolves `none`; the read service maps that directly to not-found, indistinguishable from a
   missing project, matching the slug read seams. The MCP adapter would collapse Forbidden/NotFound
   anyway, but the service contract is now consistently "not authorized == not found."
4. **Writes were already member-gated since #104; #109 is read-only.** Every MCP write tool routes
   through an `authorizeProjectWrite(…, "edit")`-gated service, so a VIEWER token is already blocked
   and an EDITOR+/ADMIN/owner token already passes — the pre-#109 write surface was actually
   _broader_ than its owner-only read surface, an incoherence #109 removes by lifting reads to match.
   **Invariant going forward:** any new MCP write tool MUST route through a `authorizeProjectWrite`-
   gated service, never the raw DB client.

API-token MANAGEMENT (`token.service`) is the one surface that stays owner-only — a token is a
personal credential (minted/listed/revoked by its owner alone), not a project resource on the
ladder. It is the sole remaining caller of the owner-only `assertCanWrite` predicate; that is
deliberate, not an oversight.

### Reaffirming ADR-0021: ranks are enforced, scopes are not

This ADR introduces an enforcement ladder for **capabilities**; it does **not** change the status
of **API token scopes**. `Role`/guest-access ranks _are_ enforced at the `access` seam — that is
their whole purpose. **Token scopes remain stored-not-enforced** (ADR-0021): authorization still
derives from `userId` (now: the userId's effective capability on the Project), and `actor.scopes`
still never decides an outcome. An Actor minted from a token (`via: "token"`, ADR-0022) is
authorized exactly as the minting user would be, and its `scopes` array is still inert. As of #109
this holds for MCP **reads** too: the read services use the identical userId→capability resolver as
the web, so there is one scope-free authz spine across both transports. Roles
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
