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
