# 4. The Canvas is a client-only island: SSR-disabled, local stylesheet, types-only across the boundary

## Status

Accepted

## Context

The **Canvas** is rendered with a diagramming library — **React Flow**
(`@xyflow/react`), introduced as a new dependency in this M1 frontend slice. The
library measures the DOM and uses browser-only APIs; it is **not
server-renderable**. Rendering it during SSR / in a React Server Component
throws or hydration-mismatches.

This repo's defining hazard is the **client/server boundary leak** documented in
`CLAUDE.md`: under `verbatimModuleSyntax`, an inline `import { type … }` pulled
from a module whose graph reaches `~/server/db` (→ `@prisma/adapter-pg` → `pg` →
Node built-ins like `dns`) drags the entire server graph into the browser
bundle. The Canvas is the first surface where rich client interactivity meets
server-derived domain types, so it is where this hazard first becomes real — and
it recurs in every later Canvas slice (drag/connect/descend, boundary proxies).

Critically, **`pnpm check` (ESLint + `tsc`) cannot detect a server-graph bundle
leak** (recorded in the team's working notes: "verify by running, not just
check"). The discipline therefore has to be structural — encoded in module
layout and a lint rule — not left to memory and review.

Stylesheet-import location also matters: a global import in `app/layout` ships
the library's CSS on every route (the dashboard, the auth pages) and couples
unrelated routes to the Canvas.

## Decision

- The Canvas is a **client-only island** (`"use client"`), loaded via
  `next/dynamic` with **`{ ssr: false }`** from a thin client wrapper, so it
  never executes on the server and never enters the RSC render path. (`ssr:
  false` is itself disallowed inside a server component in Next.js, which forces
  this wrapper layering.) `@xyflow/react` is imported in exactly **one** module,
  behind that lazy boundary, so it stays out of the page's first-load bundle.
- The island is scoped to **its own provider** (`ReactFlowProvider`), mounted
  inside the island — never in the root `app/layout`. The island is **keyed by
  its canvas scope** (`"root"` for the Project's top-level Canvas; a
  `canvasNodeId` once **Descent** lands) so the provider's store fully re-seeds
  on a scope change rather than inheriting the parent Canvas's viewport/nodes.
- Client Canvas code (and the dashboard client components) obtain all domain
  types **only from the tRPC router-output inference helpers** (`RouterOutputs`,
  re-exported through `~/lib/types`) using **top-level `import type`** — never
  from `~/server/...`. **Zod input schemas live in a Zod-only module
  (`~/lib/schemas`)** so client forms can import them as *values* without
  dragging server code.
- This rule is enforced, not just documented: an **ESLint `no-restricted-imports`
  guard** forbids importing `~/server/**` from the client directories
  (`src/app/**/_canvas/**`, `src/app/_components/**`), turning the most common
  leak vector into a failing `pnpm check` with a message pointing at `~/lib`.
- The library **stylesheet is imported locally** within the island module, not
  globally, so the CSS ships only with the Canvas's lazy chunk.
- The Canvas is reached at the **Project route** — the per-Project capability-URL
  `slug` as a path segment (`/p/[slug]`, ADR-0002). The route is a server
  component that resolves the Project by slug (reachable without a session) with
  the Canvas mounted beneath it as the SSR-disabled island. Because the slug is
  a bearer secret in the path, the route sets `Referrer-Policy: no-referrer`,
  `X-Robots-Tag: noindex`, and `Cache-Control: private, no-store`.

## Consequences

- The Canvas forfeits SSR/streaming and shows a client-side loading state on
  first paint. Accepted: the diagramming surface is inherently interactive and
  post-resolution, so SSR buys nothing here, while the bundle-leak risk it
  removes is real.
- The "types-only, from `RouterOutputs`, top-level `import type`" rule is now a
  **reviewable, lint-enforced invariant** and the template every later Canvas
  slice inherits.
- Because `pnpm check` can't see a leak, the slice's Definition of Done includes
  a **build-and-inspect** step: `pnpm build`, then confirm the client chunks
  (`​.next/static/chunks`) contain no `pg` / `node:dns` / `PrismaClient` /
  `adapter-pg`, and that React Flow loads as a *separate* lazy chunk (not in the
  route's first-load JS). The ESLint guard is the static half; this is the
  runtime half.
- Anything mounted *inside* the island is also client-only; server-derived data
  must arrive via the tRPC hydration cache (prefetch → `HydrateClient` → the
  island reads cache). For this slice the Canvas is empty and reads nothing;
  this is the seam the single-round-trip `getCanvas` payload fills in a later
  slice.
- New runtime dependency surface (`@xyflow/react`, pinned at install) and its
  CSS are now part of the build. React Flow 12 resolves `zustand@4.5.x`, which
  is React-19-compatible, so no peer overrides are required.
