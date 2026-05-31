# 21. API token scopes are stored, not enforced (yet)

## Status

Accepted

## Context

Issue #17 requires that API tokens "carry scopes." The `Actor` shape already declares
`scopes?: string[]` (CONTEXT.md *Actor*), and ADR-0001 is emphatic that authorization is derived
**only** from `userId` — "`via`/`scopes` are never used to make an authz decision." A `scopes` column
plus a `scopes` field on the Actor *looks* like an enforcement system, and a future reader could
reasonably assume a gate exists where none does. The write tools that would consume a `write` scope
(#19/#20) do not exist yet.

## Decision

**Store scopes; enforce nothing.** `ApiToken.scopes` is a `String[]` column, and every token is
minted with a single fixed value — `["read"]`. There is **no scope picker** in the UI and **no
scopes field** in the mint input: minting always grants the one scope that means something today
(memory: *prefer narrow required inputs; don't pre-add optional fields for unused future
capabilities*). The column satisfies the issue's "tokens carry scopes" requirement and keeps the
wire/DB shape stable, but **no code path reads `scopes` to make an authorization decision** — neither
the token service nor (per ADR-0001) the future MCP path. This is **continuity with ADR-0001**, not a
new exception: #17 is simply the first producer of the `via: "token"` Actor the glossary already
anticipated.

## Consequences

- The schema is forward-compatible: when a scope-gated capability lands (#19/#20), it adds a value to
  the allow-list and begins enforcing — a deliberate, ADR'd change to the `access` module, never an
  accident of a column existing.
- We avoid implying enforcement we don't have. UI copy describes capability ("This token can read
  your architecture"), never a *restriction* ("read-only, scoped") — because the true grant today is
  the minting user's full access once #18 resolves the token. See ADR-0020 and the honesty note in
  the Connect-an-agent copy.
- Reaffirms ADR-0001's invariant: removing or adding a scope value changes neither authorization nor
  the fact that `userId` is the sole authz input.
