# 7. Descent routes by Node id at `/p/[slug]/n/[nodeId]`; the breadcrumb bar renders from the hydrated `getCanvas` cache

## Status

Accepted

## Context

This slice makes **Descent** — opening a Component to enter its interior
**Canvas** — navigable. The data layer already shipped: **getCanvas** returns a
scope's interior **Nodes**/**Edges** and the **breadcrumb** trail in one round
trip (ADR-0006). What remained was routing and UI: a route per **Canvas scope**,
a way to descend, a breadcrumb bar, and hover prefetch so descent feels instant
(the performance philosophy, CLAUDE.md).

Two questions had more than one defensible answer — and each invites a future
"simplification" that would actually be a regression — so they earn a record:

1. **What does the URL carry** — the full ancestor path, or only the current
   scope?
2. **Where do breadcrumbs render, and how is a bad scope surfaced**, given that
   `getCanvas` is a single round trip (ADR-0001) and the Canvas is an
   SSR-disabled island fed only through the tRPC hydration cache (ADR-0004)?

## Decision

### The interior route is `/p/[slug]/n/[nodeId]` — the scope's Node id alone

- The segment carries **only the current scope's Node id**. The ancestor chain
  is **server-derived** from that id by the single recursive breadcrumb CTE
  (ADR-0006); it is **not** encoded in the URL. So there is **no `[...path]`
  catch-all** — that would duplicate the `parentId` tree as a second source of
  truth that can disagree with it (e.g. after a future `move`/reparent).
- `[nodeId]` is an **opaque Node id**. A URL is addressing, not prose, so this
  does not breach the Component/Node naming split (CONTEXT.md) any more than the
  capability `slug` does. The prefix is `n` (the data word, matching
  `canvasNodeId`), never `c` — there is no "Component id" to expose; the only id
  is the Node's.
- The route nests under `/p/[slug]/…`, so the bearer-slug response headers
  (`Referrer-Policy: no-referrer`, `X-Robots-Tag`, `Cache-Control: private,
  no-store`) already set on the `/p/:path*` matcher cover it with no extra work
  (ADR-0002/0004).
- **Descent is wired at the React-Flow node level** (`onNodeDoubleClick`):
  double-click opens the interior Canvas. Inline rename moved to an explicit
  hover-revealed pencil control so the two gestures no longer collide. Hover
  (`onNodeMouseEnter`) prefetches **both** the interior `getCanvas` payload and
  the route shell, so the descent is instant. A still-optimistic (`temp_`)
  Component has no real id and is excluded from descent and prefetch.

### Breadcrumbs render client-side from the hydrated `getCanvas` cache — one fetch

- The route **prefetches** the scoped `getCanvas` once (seeding the hydration
  cache). Both the Canvas island **and** a small client `<Breadcrumbs>` read that
  **same `{ slug, canvasNodeId }` query key**, so the bar costs **zero** extra
  round trips.
- This is deliberately **not** "`await getCanvas` in the server component to
  render breadcrumbs there." `@trpc/react-query/rsc`'s `createHydrationHelpers`
  runs the caller on **every** invocation, and the shared (cached) query client
  dedups query *storage*, not the *call* — so an `await` for breadcrumbs **plus**
  a `prefetch` for the island would execute the recursive CTE **twice** per
  navigation. Prefetch-once + read-from-cache keeps it single-round-trip
  (ADR-0001), which matters because that CTE is the repo's one piece of raw SQL.
- **The Project is the presentational root crumb.** The breadcrumb *trail* (the
  data) is ordered root → current and is `[]` at the root scope — no `"root"`
  sentinel ever lives in it (that string is an island key only; ADR-0004). The
  *bar* (the UI) prepends the Project title as the root crumb and marks the
  trail's last entry as the current (non-link) scope.
- A `nodeId` that resolves to no live Node in this Project throws `NOT_FOUND`
  inside that shared read. A client suspense throw cannot call the server-only
  `notFound()`, so the route's **`error.tsx`** renders the not-found UI. Showing
  it for a bad scope is acceptable existence-hiding under ADR-0002: the slug
  already grants read to the whole Project, so a bad scope *within* it reveals
  nothing about a foreign secret.

## Consequences

- **"The Descent URL carries only the scope id; ancestors are server-derived" is
  now a reviewable invariant.** Adding a `[...path]` catch-all, or stuffing the
  ancestor chain into the URL, is a regression against this ADR and ADR-0006 —
  not a feature.
- **"Breadcrumbs render from the hydrated `getCanvas`, never a second server
  read" is a reviewable invariant.** "Fixing" the client error-boundary 404 by
  awaiting `getCanvas` server-side reintroduces the double-CTE this ADR exists to
  prevent; any server-side existence check, if ever needed, must reuse the one
  prefetched read rather than add a second.
- The bad-scope 404 is a **client** boundary (`error.tsx`), not a server
  `notFound()`. Like the ADR-0004 bundle constraint, this is invisible to `pnpm
  check`, so descent, the instant-prefetch path, and the bad-scope path are part
  of this slice's **run-the-app** Definition of Done, not just the static gate.
- The island stays **keyed by scope** (ADR-0004): a Descent — or an ancestor
  crumb click — changes the `nodeId`, which flips the island key, remounting the
  `ReactFlowProvider` and re-seeding it from the new scope's hydrated payload, so
  an interior Canvas never inherits the parent's Components or viewport.
