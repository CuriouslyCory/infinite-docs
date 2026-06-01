import type { RouterOutputs } from "~/trpc/react";

/**
 * Client-facing domain types, derived from tRPC router outputs.
 *
 * Client code (the dashboard, the Canvas island) imports domain types from
 * HERE — never from `~/server/...` — so the server module graph
 * (PrismaClient -> @prisma/adapter-pg -> pg -> node:dns) can never leak into
 * the browser bundle. These are `import type` re-exports, so this module
 * erases entirely at build time. The ESLint guard in `eslint.config.js`
 * enforces the "no `~/server` from client" rule; see docs/adr/0004.
 */

export type Project = RouterOutputs["architecture"]["getProjectBySlug"];
export type ProjectListItem =
  RouterOutputs["architecture"]["listProjects"][number];

/** A single Component as the Canvas read returns it (a data-layer Node). */
export type CanvasNode =
  RouterOutputs["architecture"]["getCanvas"]["interiorNodes"][number];

/** A single Connection as the Canvas read returns it (a data-layer Edge). */
export type CanvasEdge =
  RouterOutputs["architecture"]["getCanvas"]["interiorEdges"][number];

/**
 * The full Canvas read payload — interior Components, Connections, and the
 * breadcrumb trail. Derived from the router output so it tracks every key
 * `getCanvas` returns, which is what lets the cache-merge helper preserve
 * sibling keys instead of a hand-maintained subset drifting out of sync.
 * (Cross-scope rendering — the redefined boundary proxy — is reintroduced in
 * #63.)
 */
export type CanvasData = RouterOutputs["architecture"]["getCanvas"];
