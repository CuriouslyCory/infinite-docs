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
  deleteNode,
  getCanvas,
  restoreNode,
  updateNode,
  updatePositions,
} from "~/server/architecture/node.service";
import {
  connectNodes,
  deleteEdge,
  restoreEdge,
  updateEdge,
} from "~/server/architecture/edge.service";
import {
  addFlow,
  attachFlowSpec,
  deleteFlow,
  getFlowsForNode,
  updateFlow,
} from "~/server/architecture/flow.service";
import {
  getRoutedFlowIdsForEdge,
  routeFlow,
  unrouteFlow,
} from "~/server/architecture/flow-route.service";
import {
  addFlowInput,
  attachFlowSpecInput,
  connectNodesInput,
  createNodeInput,
  createProjectInput,
  deleteEdgeInput,
  deleteFlowInput,
  deleteNodeInput,
  getCanvasInput,
  getFlowsForNodeInput,
  getProjectBySlugInput,
  getRoutedFlowIdsForEdgeInput,
  restoreEdgeInput,
  restoreNodeInput,
  routeFlowInput,
  unrouteFlowInput,
  updateEdgeInput,
  updateFlowInput,
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

  // Owner-only mutation: edit a Connection's label. Owner access is
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

  // Owner-only mutation: remove a Connection (soft-delete). When the Edge
  // carries incident FlowRoutes, the service stamps both with a fresh
  // deletionId for batch restore (Slice 2; extends ADR-0008's lone-delete
  // rule for the cascade case) — wrapped in $transaction so the multi-write
  // commits atomically.
  deleteEdge: protectedProcedure
    .input(deleteEdgeInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await ctx.db.$transaction((tx) => deleteEdge(tx, actor, input));
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation: undo a `deleteEdge` cascade — restores the Edge
  // and every FlowRoute swept alongside it. Lone-delete `deleteEdge` calls
  // (no incident FlowRoutes) mint no deletionId and so have no
  // `restoreEdge` handle; the Edge's `deletedAt` will be cleared by
  // `restoreNode` if a parent component delete swept it instead. Wrapped
  // in $transaction so the pre-checks and the two updateMany sweeps commit
  // atomically.
  restoreEdge: protectedProcedure
    .input(restoreEdgeInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await ctx.db.$transaction((tx) =>
          restoreEdge(tx, actor, input),
        );
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation: cascading soft-delete of a Component — its Node, its
  // subtree, and every incident/interior Connection — stamped with one
  // deletionId for undo. Wrapped in a transaction (like updatePositions) so the
  // recursive read and both sweeps commit atomically; owner access is enforced
  // in the service (ADR-0001).
  deleteNode: protectedProcedure
    .input(deleteNodeInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await ctx.db.$transaction((tx) => deleteNode(tx, actor, input));
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation: undo a cascading delete, restoring exactly the rows
  // stamped with the given deletionId. Owner access is enforced in the service
  // (ADR-0001).
  restoreNode: protectedProcedure
    .input(restoreNodeInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await ctx.db.$transaction((tx) => restoreNode(tx, actor, input));
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation: parse-on-write attach (or re-attach) of a FlowSpec
  // on a Component, reconciling derived Flow rows. Wrapped in a transaction
  // so the upsert + reconciliation commit atomically (ADR-0011).
  attachFlowSpec: protectedProcedure
    .input(attachFlowSpecInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await ctx.db.$transaction((tx) =>
          attachFlowSpec(tx, actor, input),
        );
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation: add a user-authored Flow (no FlowSpec). Owner
  // access is enforced in the service (ADR-0001 + ADR-0011).
  addFlow: protectedProcedure
    .input(addFlowInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await addFlow(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation: edit a Flow's title/signature. Spec-derived Flows
  // reject (ADR-0011). Owner access is enforced in the service.
  updateFlow: protectedProcedure
    .input(updateFlowInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await updateFlow(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation: soft-delete a Flow (no deletionId minted; that
  // handle ties cascading-batch deletes only — ADR-0008 + ADR-0011).
  deleteFlow: protectedProcedure
    .input(deleteFlowInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await deleteFlow(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Public: a Component's Flow palette is readable via the capability slug
  // (ADR-0002), so the detail panel works for shared-view sessions too. The
  // service confirms the ownerNodeId belongs to the slugged Project.
  getFlowsForNode: publicProcedure
    .input(getFlowsForNodeInput)
    .query(async ({ ctx, input }) => {
      const actor: Actor | null = ctx.session?.user
        ? { userId: ctx.session.user.id, via: "session" }
        : null;
      try {
        return await getFlowsForNode(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation: bind a Flow to a Connection on the same Canvas
  // (creates a FlowRoute). Slice 2 of the flow-routed-connections plan;
  // owner access is enforced in the service (ADR-0001).
  routeFlow: protectedProcedure
    .input(routeFlowInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await routeFlow(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation: remove a FlowRoute via soft-delete. A lone
  // `unrouteFlow` mints no deletionId (matches `deleteEdge` / `deleteFlow`
  // lone behavior — ADR-0008). Owner access is enforced in the service.
  unrouteFlow: protectedProcedure
    .input(unrouteFlowInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await unrouteFlow(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Public: the "+ flow" popover's unrouted filter — slug-readable per
  // ADR-0002 so the shared-view session sees consistent state.
  getRoutedFlowIdsForEdge: publicProcedure
    .input(getRoutedFlowIdsForEdgeInput)
    .query(async ({ ctx, input }) => {
      const actor: Actor | null = ctx.session?.user
        ? { userId: ctx.session.user.id, via: "session" }
        : null;
      try {
        return await getRoutedFlowIdsForEdge(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),
});
