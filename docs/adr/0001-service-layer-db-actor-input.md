# 1. Service layer with `(db, actor, input)` as the single home for business logic and authorization

## Status

Accepted

## Context

infinite-docs will be driven by two very different front doors:

1. The web app, over **tRPC**, where the caller is a signed-in user resolved from a NextAuth
   database session.
2. An authenticated **MCP server** (a later milestone), where the caller is an AI agent
   resolved from an API token.

The existing T3 scaffolding offers `protectedProcedure`, a tRPC middleware that throws
`UNAUTHORIZED` unless a session exists. If we put authorization there, it only protects the
tRPC path — the MCP path does not flow through tRPC middleware at all, so any business logic or
authorization expressed as a tRPC guard would be invisible (and unenforced) for agents. We would
end up re-implementing authorization per transport, which is exactly how authorization bugs are
born.

We also need the business logic to be **testable without a running web server or a real
session**, because M0 introduces the project's first automated test harness.

## Decision

All business logic and authorization live in a single **service layer** of plain functions with
the signature:

```
(db, actor, input) => result
```

- `db` — the Prisma client, passed in rather than imported inside the function, so tests can
  inject an isolated client and future callers can pass a transaction handle. It is typed as the
  transaction-compatible client surface (`Prisma.TransactionClient`) so a future service can run
  inside `db.$transaction(...)` and pass the `tx` into these same functions with no signature
  change.
- `actor` — the resolved caller identity, `{ userId, scopes?, via?: "session" | "token" }`,
  constructed at the edge by whichever transport is calling. Authorization is derived **only**
  from `actor.userId`; `via`/`scopes` never influence an authz decision. Service `input` never
  carries an owner id — identity comes only from the actor.
- `input` — already-validated data (re-validated at the service boundary with the same Zod
  schema the adapter uses, so non-tRPC callers are validated too).

Authorization is centralized in an **`access`** module inside this layer, exposing
`assertCanRead` (owner OR valid capability-slug) and `assertCanWrite` (owner only). Access
predicates operate over already-loaded data and never re-fetch. Service errors are
framework-agnostic domain errors carrying a stable `code`; each transport maps that code to its
own error shape (tRPC → `TRPCError`; MCP → readable tool-error text).

Transports are **thin adapters**: the `architecture` tRPC router resolves an Actor from the
session and calls the service; the future MCP server resolves an Actor from a token and calls the
same service. The tRPC `protectedProcedure` may still gate the *transport* (you must be logged in
to use the web API), but it is **not** where read/write authorization decisions are made.

## Consequences

- Authorization is written and tested **once** and is identical for the web and MCP paths. The
  capability-slug read rule (ADR-0002) and owner-only writes live in `access`, not in a guard.
- `db` as the first parameter is the **testable seam**: M0's harness exercises services directly
  against an isolated database with no HTTP or session involved (ADR-0003).
- The tRPC guard's protection is necessary but not sufficient — reviewers must remember that
  removing or loosening a `protectedProcedure` does **not** weaken authorization, and adding one
  does **not** create it. The real policy is in `access`.
- A service must never reach for the global `db` import or for ambient request context; doing so
  re-couples logic to a transport and breaks the test seam. This is a reviewable invariant.
- There is mild ceremony: callers must construct an Actor before calling. This is deliberate —
  the Actor is the explicit, auditable answer to "who is doing this," available identically to
  every transport.
- The `via: "token"` Actor anticipated here gained a **producer** in slice #17: the `ApiToken`
  model and its mint/store/revoke service (ADR-0020). Two clarifications that follow from that work,
  neither weakening this decision: (1) token **scopes are stored, not enforced** — authz still
  derives only from `userId` (ADR-0021); (2) the API-token pepper is read directly from
  `process.env` in `token-hash.ts`. That direct read is **not** the "ambient request context" this
  invariant forbids — a deployment-wide secret is config, identical for every request and transport,
  the same category as the `DATABASE_URL` the test harness reads directly (ADR-0003). Token→Actor
  *resolution* is the consumer side (#18), not this slice.
