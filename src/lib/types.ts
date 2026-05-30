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
 * A boundary proxy as the Canvas read returns it — a read-only stand-in for an
 * external Component this scope (or an ancestor) connects to, projected inward
 * (CONTEXT.md "Boundary proxy"; #13/#14). `outerEdgeId` is the routable outer
 * Connection (non-null only for `origin: "direct"`; Slice 3 / ADR-0012).
 */
export type CanvasBoundaryProxy =
  RouterOutputs["architecture"]["getCanvas"]["boundaryProxies"][number];

/** One in-scope boundary proxy's bundled Flow palette ({ flows, hasMore }). */
export type CanvasFlowPalette =
  RouterOutputs["architecture"]["getCanvas"]["flowPalettes"][string];

/** A single Flow as the boundary-proxy palette renders it. */
export type CanvasFlowPaletteItem = CanvasFlowPalette["flows"][number];

/**
 * The full Canvas read payload — interior Components, Connections, boundary
 * proxies, their Flow palettes, and the breadcrumb trail. Derived from the
 * router output so it tracks every key `getCanvas` returns, which is what lets
 * the cache-merge helper preserve sibling keys instead of a hand-maintained
 * subset drifting out of sync.
 */
export type CanvasData = RouterOutputs["architecture"]["getCanvas"];
