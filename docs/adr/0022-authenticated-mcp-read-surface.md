# 22. Authenticated MCP read surface: owner-gated token Actor over Streamable HTTP

## Status

Accepted (M5 / #18 — Authenticated MCP route + read resources + llms.txt). Builds on
[ADR-0001](0001-service-layer-db-actor-input.md) (the `(db, actor, input)` service contract;
authz lives in the service layer, not the transport guard, *because the MCP path will not pass
through that guard*), [ADR-0002](0002-capability-url-sharing.md) (the slug is a bearer read grant;
not-found is indistinguishable from forbidden), [ADR-0017](0017-deterministic-markdown-serialization.md)
(the pure-serializer / authorized-fetch split), and [ADR-0020](0020-api-token-storage-hash-at-rest-with-pepper.md)
/ [ADR-0021](0021-api-token-scopes-stored-not-enforced.md) (token hash-at-rest; scopes stored, not
enforced).

## Context

Issue #17 made a user mint an `ApiToken` (the producer); #15 made the graph serialize to deterministic
markdown. #18 is the consumer that joins them: an authenticated **MCP server**, co-located as a
Next.js route handler speaking **Streamable HTTP**, that resolves a bearer token to an **Actor** and
serves the serializer's output as read-only resources. It is the **second transport adapter** after
tRPC, and the first to exercise the `via: "token"` Actor the glossary and ADR-0001 anticipated.

Three forces shape the design:

1. **Two authorization postures must share one read path without one weakening the other.** The web
   export is *slug-grant* (ADR-0002: possession of the unguessable slug is the read). The MCP read is
   *owner-gated* (the token resolves to a `userId`; an Actor reads only its own projects). They share
   the fetch-and-serialize machinery but **not** the grant logic.
2. **The route must stay a thin adapter** (ADR-0001). Token→Actor resolution and the read are service
   concerns; the route only wires transport to them.
3. **The surface must extend additively.** #34 layers Flow MCP tools; #38 adds `flow/:id` /
   `flow-route/:id` resources and refreshes `llms.txt`. #18 must not bake in a shape those rewrite.

## Decision

### 1. Token → Actor resolution is a service function (`resolveActorFromToken`)

It re-derives the same keyed HMAC the row was stored under (`hashToken`, ADR-0020) and looks the token
up by `tokenHash @unique`, so the raw value is matched without being stored. **Every rejection —
missing, unknown, revoked, expired — returns the same `null`**, which the adapter maps to one
indistinguishable 401; the failed check is never disclosed (ADR-0002, the posture `revokeApiToken`
uses for foreign tokens). No timing-safe compare is needed: equality is a Postgres unique-index probe
(no hash is compared in JS) and the token is 256-bit CSPRNG entropy. The resolver lives beside
`createApiToken`/`revokeApiToken` so the whole token lifecycle is one testable module; the adapter
never imports `hashToken`. Single key version today (`hashToken` defaults to `CURRENT_KEY_VERSION`);
pepper rotation becomes a lookup-per-version, a purely additive change.

### 2. The read path is a three-layer split (refining ADR-0017)

ADR-0017 split *serialization* (pure `serializeGraph`) from *authorized fetch* (`exportMarkdown`).
Issue #18 refines that into three layers so two grant postures share fetch but not authz:

- **`serializeGraph(input)`** — pure, untouched.
- **`serializeProjectScope(db, {projectId, projectTitle}, {canvasNodeId, mode})`** — the shared
  fetch-and-serialize core, keyed by an already-resolved, already-authorized project. No slug, no
  authz. This is the extracted reusable unit.
- **Two front doors** over it: `exportMarkdown` (slug grant, web) and `exportMarkdownForActor`
  (owner gate, MCP). `exportMarkdownForActor` resolves the project by **internal id**, loads its
  `ownerId`, and calls `assertCanRead(actor, {ownerId})` **without** `viaCapabilitySlug` — so it is
  owner-only and the slug grant can never be reached from this path. Fetch-then-authorize over
  already-loaded data (ADR-0001): `deletedAt: null` filtering makes a soft-deleted project not-found,
  and only a live project's `ownerId` reaches the predicate.

The extraction is pure code-motion; the ADR-0017 golden byte-equality test is the backstop and stays
green.

### 3. Resources are addressed by `projectId`, never slug, never userId

The three read resources — `index`, `project`, `subtree` — are the MCP-addressable face of the
serializer's three modes (ADR-0017), **not a new data vocabulary**. They are addressed under a custom
`architecture://` URI scheme carrying `projectId` (and, for `subtree`, a `nodeId` the agent learns
from the `{#anchor}` markers in the markdown). **No resource accepts a user id** — `actor.userId` is
the only identity input, supplied by the resolved token. `resources/list` enumerates **only the
calling Actor's projects** by reusing the already-owner-scoped `listProjects`; isolation holds because
that function cannot return another user's rows. Each read re-authorizes through
`exportMarkdownForActor` (defense in depth), and the adapter collapses both not-found and forbidden to
one indistinguishable "not found" (ADR-0002 extended to the MCP transport). The catalog is a data
array (`READ_RESOURCES`); #38's Flow resources are a pure append — no change to the registration loop,
the auth gate, or the route.

### 4. Transport: `mcp-handler` over Streamable HTTP, SSE disabled, Node runtime

The route at `src/app/api/[transport]/route.ts` wires `mcp-handler`'s `createMcpHandler` +
`withMcpAuth(handler, makeVerifyMcpToken(db), { required: true })` — the verifier wraps
`resolveActorFromToken` — which rejects any tokenless request *before*
a resource handler runs. **SSE is disabled** (`disableSse: true`), so the legacy session/Redis path is
never reached — reads are stateless and the route needs **zero new configuration** (no Redis, no new
env var). The route is pinned to `runtime = "nodejs"` because the token HMAC (`node:crypto`) and the
Prisma `pg` adapter are Node-only; an edge default would break both at runtime, invisible to
`pnpm check` (so the MCP Inspector round-trip is the real acceptance gate).

### 5. `llms.txt` is generated from the resource catalog

Served from a route handler (`src/app/llms.txt/route.ts`), its resource section is rendered from the
same `READ_RESOURCES` catalog the MCP server registers from, so the discovery doc and the live
`resources/list` cannot disagree. The origin is derived from the request (proxy-aware), needing no
endpoint env var. As #34/#38 append to the catalog, the doc extends automatically.

## Consequences

- **This does NOT contradict ADR-0002.** #18 introduces a *second, parallel* grant model
  (owner-gated by token); it does not weaken the slug grant. The slug remains a bearer read grant on
  the web path and **never appears on the MCP surface** — the owner door keys off the internal id and
  never consults the slug column. A future reader must not collapse the two: they share fetch, not
  grant logic.
- **This does NOT contradict ADR-0017** — it extends it. The two-layer split becomes three; the pure
  serializer is untouched and the golden fixture stays valid (the extraction is code-motion). The
  serializer now has a second adopter and its first *owner-gated* one.
- **Scopes stay decorative (ADR-0021).** The resolved Actor carries `scopes` for shape stability, but
  no code path reads them for authz — authorization derives only from `userId`. When a scope-gated
  capability lands (#19/#20), enforcement is an additive `access`-module change, not an accident of a
  column existing.
- **Prompt-injection discharge for #18.** Untrusted Component documentation flows out through
  resources verbatim (it must — it is the product). #18's output-boundary defense is the `llms.txt`
  trust-boundary note that resource content is *data, not instructions*; active content fencing stays
  deliberately deferred (ADR-0017 Consequences), and #18 exposes no write tool to be injected against.
- **A new dependency (`mcp-handler` + `@modelcontextprotocol/sdk`).** Chosen over a hand-rolled
  JSON-RPC transport because the AC mandates MCP-Inspector compatibility and Streamable HTTP is a
  non-trivial transport; `withMcpAuth` maps cleanly onto the Actor-resolution seam. The resolver and
  resource registry are kept transport-agnostic, so swapping to the SDK transport directly would be a
  localized change.
- **Seams to siblings are left open additively.** Write tools (#19/#20/#67) add a `tools/*`
  registry beside the `resources/*` one and reuse `resolveActorFromToken`; future read resources
  append to `READ_RESOURCES` and the `llms.txt` catalog without touching the registration loop or
  the route; #23's dev-session path can add a *second* Actor producer for the same route without
  reshaping it.

## Amendment — #67 (Flow resource scrub; `apply_spec` joins the tool catalog)

The Flow capability model retired with #62 (ADR-0027/0028/0030); the
forward-named `flow/:id` / `flow-route/:id` read resources from #38 will never
ship. `READ_RESOURCES` stays frozen at `{ index, project, subtree }`. The
subtree resource's description is unchanged in shape but its underlying
boundary derivation moved to per-edge at #67 (ADR-0017 amendment): the
subtree's Boundary section now lists one row per crossing Connection (no
`direct/inherited` partition), so an agent reading a subtree resource sees
each crossing Connection named with its `interaction` glyph and the far
endpoint's anchor.

`apply_spec` (#67) joined `WRITE_TOOLS` as the sixth descriptor — a thin
adapter over `applySpec` (ADR-0029). No change to this ADR's route shape, auth
gate, or non-disclosure rule; the addition is the additive `defineTool` seam
ADR-0026 reserved. `llms.txt` picks it up via the dynamic catalog render — no
route edit was needed.

## Amendment — #60 (4th read resource: owner-gated saved Trace)

`READ_RESOURCES` gains a 4th descriptor, **`trace`** —
`architecture://trace/{traceId}` — that reads one saved **Trace** as
deterministic markdown of its cross-layer on-path subgraph (#60). It is a pure
APPEND to the catalog: no change to the auth gate, the single-401 path, or the
non-disclosing error mapping.

Two things differ from the project-scoped three, and both are deliberate:

- **It is backed by a different service.** The three project resources call
  `exportMarkdownForActor`; the trace resource calls a new owner-gated front
  door `getTraceMarkdownForActor(db, actor, { traceId })` (in
  `trace.service.ts`) — addressed by internal `traceId`, never a slug. The
  service resolves the Trace → its Project's `ownerId` → `assertCanRead`
  WITHOUT `viaCapabilitySlug` (owner-only, exactly as `exportMarkdownForActor`).
  A foreign owner, a soft-deleted Trace, a Trace under a soft-deleted Project,
  or an unknown id all collapse to one non-disclosing `toMcpReadError` message —
  existence never leaks across owners. A real, owned, degenerate Trace (< 2 live
  trace points) is NOT an error: it returns valid markdown with an
  insufficient-points note (the markdown analogue of the web empty state).
  This is the same slug-readable-in-app vs owner-gated-MCP asymmetry the
  in-app saved route (#59) and `exportMarkdown` vs `exportMarkdownForActor`
  already embody.
- **The catalog stays data-only; dispatch lives in `resources.ts`.** The
  descriptor carries a new `kind: "project" | "trace"` discriminant (no service
  import in `catalog.ts`, so `llms.txt` still does not pull the MCP/Prisma
  graph). `resources.ts` branches on `descriptor.kind` to pick the service.
  `enumerateProjects: false` (like `subtree`) — no `resources/list` enumeration
  of traces; agents learn the `traceId` from the saved route. `llms.txt` picks
  the new resource up via the dynamic catalog render — no route edit.
