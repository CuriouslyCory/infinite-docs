import { z } from "zod";

/**
 * Zod input schemas for the architecture service layer. This module imports
 * only `zod` (no server reach) so a future client form can import these as
 * values for shared validation without pulling the server graph into the
 * browser bundle.
 */

export const createProjectInput = z.object({
  title: z.string().min(1).max(200),
});
export type CreateProjectInput = z.infer<typeof createProjectInput>;

export const getProjectBySlugInput = z.object({
  slug: z.string().min(1),
});
export type GetProjectBySlugInput = z.infer<typeof getProjectBySlugInput>;
