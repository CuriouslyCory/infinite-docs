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
 * A Component as the project-wide "Connect to…" search returns it (#66) — a flat,
 * scope-independent row carrying `parentId` so the client can rebuild each
 * Component's ancestor path for disambiguation without a server walk.
 */
export type ProjectComponent =
  RouterOutputs["architecture"]["listProjectComponents"][number];

/**
 * One Connection incident to a Component, as the detail panel's Connections
 * section lists it (#66) — complete across scopes, with the far endpoint resolved
 * to its display fields and `sourceIsSelf` for arrow orientation (ADR-0032).
 */
export type NodeConnection =
  RouterOutputs["architecture"]["listNodeConnections"][number];

/**
 * The full Canvas read payload — interior Components, Connections, the boundary
 * proxies cross-scope Connections need, and the breadcrumb trail. Derived from
 * the router output so it tracks every key `getCanvas` returns, which is what lets
 * the cache-merge helper preserve sibling keys instead of a hand-maintained
 * subset drifting out of sync.
 */
export type CanvasData = RouterOutputs["architecture"]["getCanvas"];

/**
 * The full cross-layer **Trace view** payload (#58): the on-path Components and
 * Connections of the **Trace subgraph**, the valid trace-point id subset, and
 * the truncation flag/warning. Derived read-only by `getTraceView` over the
 * unified undirected (Connection ∪ nesting) graph, capped at 500 Components
 * (ADR-0034). The client consumes ONLY via this type (ADR-0004), never from
 * `~/server`.
 */
export type TraceView = RouterOutputs["architecture"]["getTraceView"];

/** A single on-path Component in the Trace subgraph — carries `parentId` so the
 *  client builds the nested boxes, `documentation` so the read-only detail panel
 *  opens with no click-time round trip, and `isTracePoint` to highlight the
 *  endpoints distinctly from path-only intermediaries and ancestor containers. */
export type TraceViewNode = TraceView["nodes"][number];

/** A single on-path Connection in the Trace subgraph — real `sourceId`/`targetId`
 *  (no boundary-proxy reprojection; every layer is on screen at once). */
export type TraceViewEdge = TraceView["edges"][number];
