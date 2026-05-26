# 2. Capability-URL sharing for read access

## Status

Accepted

## Context

A core product philosophy is convenience: links should be share-able by default, and users
should not hit friction (sign-in walls, access-request flows) just to *view* an architecture.
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
