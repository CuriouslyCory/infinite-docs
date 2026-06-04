# 2. Capability-URL sharing for read access

## Status

Accepted

## Context

A core product philosophy is convenience: links should be share-able by default, and users
should not hit friction (sign-in walls, access-request flows) just to _view_ an architecture.
At the same time, the graph is mutable — increasingly by AI agents — so writes must stay locked
down.

We need a sharing model for a `Project` that:

- lets anyone with a link **read** the Project without authenticating,
- keeps **writes** restricted to the owner,
- does not require building roles, invitations, or an ACL table for the first slice.

## Decision

Each `Project` carries an unguessable, unique **capability-URL slug** (`slug @unique`).
**Possession of the slug grants read access** — the URL itself is the capability (a bearer
token in the path). No sign-in is required to read a Project you have the link to. The slug is
generated server-side from a CSPRNG (128 bits, URL-safe), never derived from user input, and is
distinct from the primary key so it can be rotated later without breaking internal relations.

**Writes are never granted by the slug.** Mutation requires the signed-in **owner**
(`actor.userId === project.ownerId`). This rule is enforced in the `access` module of the
service layer (ADR-0001), specifically:

- `assertCanRead` — passes if the Actor is the owner **or** a valid capability context was
  presented. The slug-based read path (`getProjectBySlug`) treats possession of the slug as the
  grant directly: it resolves the project by slug and does not require an Actor.
- `assertCanWrite` — passes only if the Actor is the owner.

A missing or soft-deleted project is reported as not-found, never revealing whether a slug
exists-but-forbidden.

## Consequences

- Sharing is "copy the link" with zero setup — directly serves the convenience and
  good-defaults philosophies. All links are share links by default.
- The slug is a **bearer secret**: anyone it is forwarded to can read the Project. That is the
  intended trade. It must therefore be treated like a secret in logs and analytics, and a future
  milestone may add slug rotation / revocation to recover from accidental disclosure. (Rotation
  is out of scope for M0.)
- Because reads can be authorized by slug **without a session**, read authorization cannot live
  in the tRPC `protectedProcedure` guard — it must live in `access` (ADR-0001). This is the
  concrete reason the service layer, not the framework guard, owns authorization.
- No roles, sharing table, or invitation flow is needed yet. The model is intentionally minimal:
  owner-writes, link-reads. Richer collaboration, if ever needed, is a later, separate decision.
- The owner check is an identity comparison against `actor.userId`; it is transport-agnostic and
  applies equally to the web app and the future MCP path.
- The slug is no longer the only bearer secret: the **API token** (ADR-0020), minted from the
  Connect-an-agent page for agents on the MCP path, is the second. The "treat as a secret in logs
  and analytics" posture above applies identically to API tokens and the server-side token pepper,
  and the not-found-not-forbidden non-disclosure rule extends too — a token belonging to another
  user is reported not-found, never revealing it exists.

## Viewer surfaces (issue #16)

A non-owner who holds the slug is a **viewer**. The web client derives ownership from the data it
already has — `isOwner = session?.user?.id === project.ownerId` (`project.ownerId` ships in
`getProjectBySlug`, no new exposure) — and presents a **read-only mode** when `!isOwner`:

- Every edit affordance is hidden (add / drag / connect / delete, rename, kind change, label edit,
  FlowSpec paste, Flow CRUD, routing).
- A read-only **Component-detail panel** still opens so the viewer can read a Component's
  documentation (Plate `readOnly`, ADR-0015) and its **Flow palette** — the same content
  `getCanvas` / `getFlowsForNode` already serve by slug. This resolves the gap ADR-0015
  §Alternatives flagged: `documentation` was already shipped to slug viewers but not yet surfaced.
- A **"View only"** badge in the project header makes the read-only state legible.

**The read-only mode is presentation, not the authorization boundary.** Hidden affordances and the
badge are UX; they do not gate anything. Every mutation is denied at the service layer
(`access.assertCanWrite`, ADR-0001) regardless of what the client renders — a viewer who forges a
request is rejected there. Do not loosen a service-layer gate on the reasoning that "the UI hides
it anyway"; both the transport gate (`protectedProcedure`) and the service policy
(`assertCanWrite`) are required, and the service policy is the one that actually decides. This
posture is verified by per-mutation non-owner-denial tests and capability-read-allow tests.
