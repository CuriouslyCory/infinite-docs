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

/**
 * A single Connection as the Canvas read returns it — the stored Edge fields plus
 * the derived `sourceRepr`/`targetRepr` that resolve each endpoint onto the
 * current scope (a real Node, an ancestor for the altitude view, or a boundary
 * proxy's synthetic id). Derived per scope from endpoint ancestry, never a stored
 * Edge scope (ADR-0031).
 */
export type CanvasEdge =
  RouterOutputs["architecture"]["getCanvas"]["interiorEdges"][number];

/**
 * A read-only stand-in for the off-scope endpoint of a cross-scope Connection,
 * one per crossing edge (ADR-0031). The client renders it as a passive node (#65).
 */
export type CanvasBoundaryProxy =
  RouterOutputs["architecture"]["getCanvas"]["boundaryProxies"][number];

/**
 * The full Canvas read payload — interior Components, Connections, the boundary
 * proxies cross-scope Connections need, and the breadcrumb trail. Derived from
 * the router output so it tracks every key `getCanvas` returns, which is what lets
 * the cache-merge helper preserve sibling keys instead of a hand-maintained
 * subset drifting out of sync.
 */
export type CanvasData = RouterOutputs["architecture"]["getCanvas"];
