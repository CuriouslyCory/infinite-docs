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
  createNode,
  getCanvas,
  updateNode,
  updatePositions,
} from "~/server/architecture/node.service";
import {
  connectNodes,
  deleteEdge,
  updateEdge,
} from "~/server/architecture/edge.service";
import {
  connectNodesInput,
  createNodeInput,
  createProjectInput,
  deleteEdgeInput,
  getCanvasInput,
  getProjectBySlugInput,
  updateEdgeInput,
  updateNodeInput,
  updatePositionsInput,
} from "~/lib/schemas";
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

  // Owner-only mutation: the service resolves the project by `projectId` and
  // enforces owner access. `protectedProcedure` is the transport gate (you must
  // be signed in); the real authorization is in the service (ADR-0001).
  createNode: protectedProcedure
    .input(createNodeInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await createNode(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Public: the slug is the read capability, so a capability-URL viewer can read
  // the Canvas without a session (ADR-0002).
  getCanvas: publicProcedure
    .input(getCanvasInput)
    .query(async ({ ctx, input }) => {
      const actor: Actor | null = ctx.session?.user
        ? { userId: ctx.session.user.id, via: "session" }
        : null;
      try {
        return await getCanvas(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation (inline rename). `protectedProcedure` is the transport
  // gate; the real authorization is in the service (ADR-0001).
  updateNode: protectedProcedure
    .input(updateNodeInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await updateNode(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation: the single batched position write committed on
  // drag-stop. Owner access is enforced in the service (ADR-0001).
  updatePositions: protectedProcedure
    .input(updatePositionsInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await ctx.db.$transaction((tx) =>
          updatePositions(tx, actor, input),
        );
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation: draw a Connection. `protectedProcedure` is the
  // transport gate; the real authorization is in the service (ADR-0001).
  connectNodes: protectedProcedure
    .input(connectNodesInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await connectNodes(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation: edit a Connection's label/direction. Owner access is
  // enforced in the service (ADR-0001).
  updateEdge: protectedProcedure
    .input(updateEdgeInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await updateEdge(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation: remove a Connection (soft-delete). Owner access is
  // enforced in the service (ADR-0001).
  deleteEdge: protectedProcedure
    .input(deleteEdgeInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await deleteEdge(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),
});
