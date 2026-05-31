# 20. API token storage: hash-at-rest with a versioned server pepper

## Status

Accepted

## Context

PRD #2 needs an authenticated MCP server (#18) so AI agents can read and maintain the architecture.
That server resolves a **bearer token to an Actor** (CONTEXT.md *Actor*, `via: "token"`). Issue #17
builds the producer side: a signed-in user mints API tokens for agents and revokes them from a
"Connect an agent" page. We must decide how a token is generated, stored, and looked up — given that
an API token is the system's **second bearer secret** alongside the capability-URL slug (ADR-0002),
and that the consumer (#18) must be able to resolve a *presented* token to its row cheaply.

The constraints in tension:

- A database leak must not yield replayable credentials.
- #18 resolves a token by looking it up — so the at-rest form must be **deterministic** (you cannot
  look a token up by a per-row-salted hash without first having its row).
- The service layer must stay testable without `~/env` (ADR-0003): `test-db.ts` deliberately reads
  `process.env.DATABASE_URL` directly so a service test needn't supply unrelated auth secrets.
- ADR-0001 forbids a service reaching for ambient **request** context.

## Decision

**Store only a keyed HMAC of the token, never the raw value.** At mint:

- The raw token is `infdoc_` + 32 bytes (256 bits) of CSPRNG entropy, URL-safe base64
  (`generateRawToken` in `token-hash.ts`, mirroring `slug.ts`). The `infdoc_` tag is a recognizable
  issuer prefix — greppable in logs, registrable with secret scanners.
- `tokenHash = HMAC-SHA256(pepper, raw)`, hex-encoded, stored `@unique`. This is the **only**
  persisted form of the secret. A non-secret `prefix` (the leading ~12 chars of the raw token) is
  stored for display so the owner can recognize a token in the list.
- The raw token is returned to the client **exactly once** and is never persisted or logged.

**HMAC-SHA256, not bcrypt/argon2.** Slow password hashes defend *low-entropy* human passwords against
offline brute force. The token is 256-bit CSPRNG output — there is no brute-force surface to slow
down — and a deterministic keyed digest is exactly what #18 needs to look a token up by hash. The
pepper (a server-side secret) is what defends against a database-only leak: without it, a leaked row
cannot confirm a guessed token. There is **no per-row salt** — it would break lookup-by-hash; the
pepper plays salt's role globally.

**The pepper is read directly from `process.env.API_TOKEN_PEPPER`** in `token-hash.ts`, *not* via
`~/env`. `~/env` remains the single **validation** authority — `API_TOKEN_PEPPER` is added to its
server schema (required in production, optional in dev like `AUTH_SECRET`) and `runtimeEnv` map, so a
production build fails without it. The direct read is a deliberate carve-out that mirrors
`test-db.ts`: it keeps the token service importable in a service test without dragging in the full
env validation (ADR-0003). A deployment-wide secret read from `process.env` is **config, not the
per-request ambient context** ADR-0001's invariant forbids. `token-hash.ts` throws a clear error if
the pepper is unset, so a misconfigured deploy fails loudly rather than hashing with `undefined`.

**A `keyVersion` column enables pepper rotation.** Each token stores the pepper version that keyed
its hash (`CURRENT_KEY_VERSION = 1` today). To rotate, add a new pepper + version: new tokens hash
under the current version, existing tokens keep verifying under their stored version, and a leaked
pepper can be retired by minting forward and expiring old tokens — all without a hash migration and
without #18 changing (it reads `keyVersion` off the row before hashing).

**Revocation is soft and owner-only.** `revokeApiToken` stamps `revokedAt` and keeps the row (prefix
+ audit trail survive); it is idempotent. Mint/list/revoke authorize only against the owning
`userId` (ADR-0001); a token belonging to another user is reported **not-found**, never forbidden, so
existence never leaks (ADR-0002's posture). Writes are never slug-granted.

**Out of scope here (owned by #18):** the MCP route, token→Actor resolution, and the
revocation/expiry *checks* at a read edge. #17's only handoff is the deterministic `hashToken(raw,
keyVersion)` whose output equals the `tokenHash` column, plus the column set #18 reads. Scope
*enforcement* is out of scope and may never exist as a gate (ADR-0021).

## Consequences

- A database dump alone cannot produce a usable token; an attacker also needs the pepper.
- The deterministic keyed hash lets #18 resolve a presented token with one `findUnique` — the
  rationale that makes HMAC (not bcrypt) the correct choice. **Do not "harden" this to a salted slow
  hash**: it would break #18.
- The pepper is a top-tier secret. It inherits the slug's "treat as a secret in logs and analytics"
  posture (ADR-0002). The `keyVersion` column makes rotation a routine operation rather than an
  unrecoverable incident — without it, a leaked pepper would mean every hash is at once
  brute-forceable *and* unrotatable (changing it invalidates all tokens). We accept the residual risk
  that a v1-pepper leak still exposes v1 tokens until they are rotated forward and expired.
- **Non-expiring tokens are an allowed owner choice.** The mint flow offers 30/90/365 days or "No
  expiry" (default 90). A non-expiring agent token is a standing exposure; the UI warns, and the
  owner can always revoke. This favors convenience while keeping the kill-switch one click away.
- `API_TOKEN_PEPPER` must be set in `.env.test` or the service tests throw — documented in
  `.env.test.example` and a comment atop `token.service.test.ts`.
