import { z } from "zod";

/**
 * Zod input schemas for the architecture service layer.
 *
 * Lives in `~/lib` (not `~/server`) and imports only `zod`, so client forms
 * can import these as VALUES for shared validation without pulling the server
 * module graph into the browser bundle. The service layer re-validates with
 * the same schemas at its boundary, so this module is the single source of
 * truth for input shape on both sides. See docs/adr/0004.
 */

export const createProjectInput = z.object({
  title: z.string().min(1).max(200),
});
export type CreateProjectInput = z.infer<typeof createProjectInput>;

export const getProjectBySlugInput = z.object({
  slug: z.string().min(1),
});
export type GetProjectBySlugInput = z.infer<typeof getProjectBySlugInput>;

/**
 * The six Component kinds. This Zod enum is the client-safe source of truth for
 * the value set (the kind picker imports `nodeKind.options` as values); the
 * Prisma `NodeKind` enum mirrors it, and a compile-time parity guard in the
 * service layer fails the build if the two ever drift. Kind is cosmetic — it
 * drives only icon/color (see CONTEXT.md "Component kind"). Never import the
 * Prisma enum into client code (it reaches the server graph); import this.
 */
export const nodeKind = z.enum([
  "GENERIC",
  "SERVICE",
  "DATABASE",
  "EXTERNAL_API",
  "HOST",
  "QUEUE",
]);
export type NodeKind = z.infer<typeof nodeKind>;

/**
 * Input for creating a Component. Addressed by `projectId` (an internal handle),
 * NOT by the capability slug: writes are never granted by the slug (ADR-0002),
 * so the write path does not even accept one — the service resolves the project
 * by id and enforces owner-only access. `input` carries no ownerId; identity
 * comes only from the actor (ADR-0001). `parentId` is the Canvas scope (null =>
 * the Project's root Canvas).
 */
export const createNodeInput = z.object({
  projectId: z.string().min(1),
  parentId: z.string().nullable().default(null),
  kind: nodeKind.default("GENERIC"),
  title: z.string().min(1).max(200).default("Untitled"),
  posX: z.number().finite().default(0),
  posY: z.number().finite().default(0),
});
// `z.input` (not `z.infer`/`z.output`) so callers may omit the defaulted fields;
// the service re-parses with the schema to materialize the defaults.
export type CreateNodeInput = z.input<typeof createNodeInput>;

/**
 * Input for reading a Canvas. Addressed by the capability `slug` (the read grant,
 * ADR-0002), so it works without a session. `canvasNodeId` is the Canvas scope:
 * null reads the Project's root Canvas, a Node id reads that Component's interior
 * Canvas (interior scopes land with Descent in a later slice).
 */
export const getCanvasInput = z.object({
  slug: z.string().min(1),
  canvasNodeId: z.string().nullable().default(null),
});
export type GetCanvasInput = z.input<typeof getCanvasInput>;
