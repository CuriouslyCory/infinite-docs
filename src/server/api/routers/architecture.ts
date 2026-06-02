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
  listProjectComponents,
  restoreNode,
  updateNode,
  updateNodeDocumentation,
  updateNodeKind,
  updatePositions,
} from "~/server/architecture/node.service";
import {
  connectNodes,
  deleteEdge,
  listNodeConnections,
  restoreEdge,
  updateEdge,
  updateEdgeInteraction,
} from "~/server/architecture/edge.service";
import { exportMarkdown } from "~/server/architecture/export.service";
import { applySpec, previewSpec } from "~/server/architecture/spec.service";
import {
  applySpecInput,
  connectNodesInput,
  createNodeInput,
  createProjectInput,
  deleteEdgeInput,
  deleteNodeInput,
  exportMarkdownInput,
  getCanvasInput,
  getProjectBySlugInput,
  listNodeConnectionsInput,
  listProjectComponentsInput,
  previewSpecInput,
  restoreEdgeInput,
  restoreNodeInput,
  updateEdgeInput,
  updateEdgeInteractionInput,
  updateNodeDocumentationInput,
  updateNodeInput,
  updateNodeKindInput,
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

  // Public: the project-wide Component list powering the "Connect to…" search
  // (#66). Slug is the read capability (ADR-0002) — same posture as `getCanvas`.
  listProjectComponents: publicProcedure
    .input(listProjectComponentsInput)
    .query(async ({ ctx, input }) => {
      const actor: Actor | null = ctx.session?.user
        ? { userId: ctx.session.user.id, via: "session" }
        : null;
      try {
        return await listProjectComponents(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Public: a Component's complete incident Connections for the detail panel's
  // Connections section (#66 / ADR-0032). Slug-readable so a viewer sees the
  // read-only list (ADR-0002), same posture as `getCanvas`.
  listNodeConnections: publicProcedure
    .input(listNodeConnectionsInput)
    .query(async ({ ctx, input }) => {
      const actor: Actor | null = ctx.session?.user
        ? { userId: ctx.session.user.id, via: "session" }
        : null;
      try {
        return await listNodeConnections(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Public: deterministic markdown export of a Project or one of its
  // subtrees. Slug is the read capability (ADR-0002) — same posture as
  // `getCanvas`. See ADR-0017 (determinism contract) and #15.
  exportMarkdown: publicProcedure
    .input(exportMarkdownInput)
    .query(async ({ ctx, input }) => {
      const actor: Actor | null = ctx.session?.user
        ? { userId: ctx.session.user.id, via: "session" }
        : null;
      try {
        return await exportMarkdown(ctx.db, actor, input);
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

  // Owner-only mutation: change a Component's kind (the kind palette). Kind is
  // cosmetic — no cascade. `protectedProcedure` is the transport gate; the real
  // authorization is in the service (ADR-0001; ADR-0018).
  updateNodeKind: protectedProcedure
    .input(updateNodeKindInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await updateNodeKind(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation (debounced docs autosave). `protectedProcedure` is the
  // transport gate; the real authorization is in the service (ADR-0001).
  updateNodeDocumentation: protectedProcedure
    .input(updateNodeDocumentationInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await updateNodeDocumentation(ctx.db, actor, input);
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

  // Owner-only mutation: upgrade a Connection's interaction (the picker on the
  // selected edge; #65). Owner access + the de-dupe re-check live in the
  // service (ADR-0001); a collision surfaces as a CONFLICT.
  updateEdgeInteraction: protectedProcedure
    .input(updateEdgeInteractionInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await updateEdgeInteraction(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation: remove a Connection via a plain lone soft-delete
  // (no cascade — the FlowRoute cascade is gone; ADR-0030).
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

  // Owner-only mutation: undo a `deleteNode` Edge sweep — restores the Edges
  // stamped with the given deletionId. A lone `deleteEdge` mints no deletionId
  // and so has no `restoreEdge` handle. Wrapped in $transaction so the
  // pre-check and the updateMany sweep commit atomically.
  restoreEdge: protectedProcedure
    .input(restoreEdgeInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await ctx.db.$transaction((tx) => restoreEdge(tx, actor, input));
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

  // Owner-only, READ-ONLY action: parse a pasted Spec and diff it against the
  // owner Component's existing generated children, returning the classification
  // that drives the conflict modal. A mutation (not a query) because it's an
  // imperative action over a large `source` body, never reactive/cached data —
  // and it writes nothing (cancel = zero writes; #64). Authz is in the service.
  previewSpec: protectedProcedure
    .input(previewSpecInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await previewSpec(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Owner-only mutation: apply a previewed Spec (create/overwrite/detach/delete
  // per the user's resolutions). Wrapped in a transaction so a per-row reject
  // rolls the whole merge back — never a partial apply (#64). Owner access is
  // enforced in the service (ADR-0001).
  applySpec: protectedProcedure
    .input(applySpecInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await ctx.db.$transaction((tx) => applySpec(tx, actor, input));
      } catch (error) {
        throw toTRPCError(error);
      }
    }),
});
