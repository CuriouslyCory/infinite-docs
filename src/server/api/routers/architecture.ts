import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "~/server/api/trpc";
import { type Actor } from "~/server/architecture/actor";
import {
  createProject,
  getProjectBySlug,
  listProjects,
} from "~/server/architecture/project.service";
import {
  createProjectInput,
  getProjectBySlugInput,
} from "~/server/architecture/schemas";
import { toTRPCError } from "~/server/architecture/trpc-errors";

/**
 * Thin adapter over the architecture service layer: resolve an Actor, call the
 * service, map domain errors to TRPCErrors. No business logic and no direct
 * `ctx.db` access live here (see docs/adr/0001).
 */
export const architectureRouter = createTRPCRouter({
  createProject: protectedProcedure
    .input(createProjectInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await createProject(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  listProjects: protectedProcedure.query(async ({ ctx }) => {
    const actor: Actor = { userId: ctx.session.user.id, via: "session" };
    try {
      return await listProjects(ctx.db, actor);
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  // Public: the slug is the read capability, so this must work without a session.
  getProjectBySlug: publicProcedure
    .input(getProjectBySlugInput)
    .query(async ({ ctx, input }) => {
      const actor: Actor | null = ctx.session?.user
        ? { userId: ctx.session.user.id, via: "session" }
        : null;
      try {
        return await getProjectBySlug(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),
});
