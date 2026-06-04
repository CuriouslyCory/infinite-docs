import {
  createTRPCRouter,
  protectedProcedure,
  publicProcedure,
} from "~/server/api/trpc";
import { type Actor } from "~/server/architecture/actor";
import {
  createProject,
  deleteProject,
  getProjectAccess,
  getProjectBySlug,
  listProjects,
  setGuestAccess,
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
  upsertBoundaryProxyPlacement,
} from "~/server/architecture/node.service";
import {
  connectNodes,
  deleteEdge,
  listNodeConnections,
  restoreEdge,
  updateEdge,
  updateEdgeInteraction,
} from "~/server/architecture/edge.service";
import {
  claimInvite,
  createInvite,
} from "~/server/architecture/invite.service";
import { exportMarkdown } from "~/server/architecture/export.service";
import {
  createTrace,
  deleteTrace,
  getTrace,
  getTraceView,
  listTraces,
  renameTrace,
} from "~/server/architecture/trace.service";
import {
  applySpec,
  BULK_WRITE_TIMEOUT_MS,
  previewSpec,
} from "~/server/architecture/spec.service";
import {
  applySpecInput,
  claimInviteInput,
  connectNodesInput,
  createInviteInput,
  createNodeInput,
  createProjectInput,
  createTraceInput,
  deleteEdgeInput,
  deleteNodeInput,
  deleteProjectInput,
  deleteTraceInput,
  exportMarkdownInput,
  getCanvasInput,
  getProjectAccessInput,
  getProjectBySlugInput,
  getTraceInput,
  getTraceViewInput,
  listNodeConnectionsInput,
  listProjectComponentsInput,
  listTracesInput,
  renameTraceInput,
  previewSpecInput,
  restoreEdgeInput,
  setGuestAccessInput,
  restoreNodeInput,
  updateEdgeInput,
  updateEdgeInteractionInput,
  updateNodeDocumentationInput,
  updateNodeInput,
  updateNodeKindInput,
  updatePositionsInput,
  upsertBoundaryProxyPlacementInput,
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

  // Owner-only mutation: the service resolves the project by `slug` and enforces
  // `owner` via the capability ladder (a non-owner ADMIN cannot delete; ADR-0040).
  // `protectedProcedure` is the transport gate (you must be signed in); the real
  // authorization is in the service (ADR-0001).
  deleteProject: protectedProcedure
    .input(deleteProjectInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await deleteProject(ctx.db, actor, input);
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

  // ADMIN+ mutation: set the project's anonymous-link access level (#105). The
  // service gates on `admin` via the id-keyed write seam (owner or ADMIN member;
  // ADR-0040). `protectedProcedure` is the transport gate (you must be signed in
  // — only an ADMIN+ identity ever reaches a success); real authz is in the
  // service (ADR-0001).
  setGuestAccess: protectedProcedure
    .input(setGuestAccessInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await setGuestAccess(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // ADMIN+ query: read the project's sharing/access facts powering the ShareMenu
  // toggle (#105; growable for #108). The service composes the non-disclosure
  // ladder (NotFound for a non-reader, Forbidden for a reader below admin) and
  // returns the facts only to owner/ADMIN. `protectedProcedure` is the transport
  // gate; real authz is in the service (ADR-0001/0040).
  getProjectAccess: protectedProcedure
    .input(getProjectAccessInput)
    .query(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await getProjectAccess(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // ADMIN+ mutation: mint a role-bearing invite link (#106). The service gates on
  // `admin` via the id-keyed write seam (owner or ADMIN member; ADR-0040) and
  // returns the raw `infinv_…` token EXACTLY once. `protectedProcedure` is the
  // transport gate; real authz is in the service (ADR-0001/0040).
  createInvite: protectedProcedure
    .input(createInviteInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await createInvite(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Signed-in mutation: redeem an invite link into a Membership (#106). The whole
  // race-safe/idempotent/non-disclosing claim protocol lives in the service (one
  // READ COMMITTED transaction; ADR-0040). Every invalid state collapses to one
  // `NOT_FOUND` the `/i/[token]` shell renders as "invalid or expired" — no
  // project disclosure. `protectedProcedure` enforces the signed-in requirement;
  // anon is redirected to sign-in by the route shell before this is ever called.
  claimInvite: protectedProcedure
    .input(claimInviteInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await claimInvite(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Write mutation (`edit`+): the service resolves the project by `projectId` and
  // gates on `edit` via the capability ladder — owner, ADMIN, or EDITOR member
  // (ADR-0040). `protectedProcedure` is the transport gate (you must be signed
  // in); the real authorization is in the service (ADR-0001).
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

  // Public: the cross-layer Trace view read (#58). Slug is the read capability
  // (ADR-0002) — same slug-bind posture as `getCanvas`; `nodeIds` are the
  // working-trace point set, client state the RSC can't prefetch (ADR-0034).
  getTraceView: publicProcedure
    .input(getTraceViewInput)
    .query(async ({ ctx, input }) => {
      const actor: Actor | null = ctx.session?.user
        ? { userId: ctx.session.user.id, via: "session" }
        : null;
      try {
        return await getTraceView(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Public: the Project's saved Traces (#59 / ADR-0035). Slug is the read
  // capability (ADR-0002) — same posture as `getTraceView`; both owner and viewer
  // see the list. The viewer's missing Save/Rename/Delete is UI; the real write
  // gate is the `edit` capability ladder in the write services (ADR-0040).
  listTraces: publicProcedure
    .input(listTracesInput)
    .query(async ({ ctx, input }) => {
      const actor: Actor | null = ctx.session?.user
        ? { userId: ctx.session.user.id, via: "session" }
        : null;
      try {
        return await listTraces(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Public: one saved Trace by id, scoped to the slug's Project (#59). Slug is the
  // read capability — this is what the saved route `/p/[slug]/trace/[traceId]`
  // reads (ADR-0035).
  getTrace: publicProcedure
    .input(getTraceInput)
    .query(async ({ ctx, input }) => {
      const actor: Actor | null = ctx.session?.user
        ? { userId: ctx.session.user.id, via: "session" }
        : null;
      try {
        return await getTrace(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Write mutation (`edit`+): save the working trace as a named Trace (#59 /
  // ADR-0035). Wrapped in $transaction so the Trace + its TracePoint rows commit
  // atomically (like deleteNode). `protectedProcedure` is the transport gate; the
  // real authz is the `edit` capability ladder in the service (ADR-0001/0040).
  createTrace: protectedProcedure
    .input(createTraceInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await ctx.db.$transaction((tx) => createTrace(tx, actor, input));
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Write mutation (`edit`+): rename a saved Trace (name only; #59). The `edit`
  // capability ladder is enforced in the service (ADR-0001/0040).
  renameTrace: protectedProcedure
    .input(renameTraceInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await renameTrace(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Write mutation (`edit`+): soft-delete a saved Trace, stamping a deletionId for
  // a future undo (no restoreTrace UI in #59; ADR-0030/0035). The `edit`
  // capability ladder is enforced in the service (ADR-0001/0040).
  deleteTrace: protectedProcedure
    .input(deleteTraceInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await deleteTrace(ctx.db, actor, input);
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

  // Write mutation (`edit`+, inline rename). `protectedProcedure` is the transport
  // gate; the `edit` capability ladder is enforced in the service (ADR-0001/0040).
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

  // Write mutation (`edit`+): change a Component's kind (the kind palette). Kind is
  // cosmetic — no cascade. `protectedProcedure` is the transport gate; the `edit`
  // capability ladder is enforced in the service (ADR-0001/0040; ADR-0018).
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

  // Write mutation (`edit`+, debounced docs autosave). `protectedProcedure` is the
  // transport gate; the `edit` capability ladder is enforced in the service
  // (ADR-0001/0040).
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

  // Write mutation (`edit`+): the single batched position write committed on
  // drag-stop. The `edit` capability ladder is enforced in the service
  // (ADR-0001/0040).
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

  // Write mutation (`edit`+): persist where a boundary proxy sits on one scope's
  // Canvas (#91 / ADR-0036). `protectedProcedure` is the transport gate; the
  // `edit` capability ladder is enforced in the service (ADR-0001/0040). The
  // service does its own find-then-write with a P2002 race backstop, so no
  // wrapping transaction.
  upsertBoundaryProxyPlacement: protectedProcedure
    .input(upsertBoundaryProxyPlacementInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await upsertBoundaryProxyPlacement(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  // Write mutation (`edit`+): draw a Connection. `protectedProcedure` is the
  // transport gate; the `edit` capability ladder is enforced in the service
  // (ADR-0001/0040).
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

  // Write mutation (`edit`+): edit a Connection's label. The `edit` capability
  // ladder is enforced in the service (ADR-0001/0040).
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

  // Write mutation (`edit`+): upgrade a Connection's interaction (the picker on the
  // selected edge; #65). The `edit` capability ladder + the de-dupe re-check live
  // in the service (ADR-0001/0040); a collision surfaces as a CONFLICT.
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

  // Write mutation (`edit`+): remove a Connection via a plain lone soft-delete
  // (no cascade — the FlowRoute cascade is gone; ADR-0030). The `edit` capability
  // ladder is enforced in the service (ADR-0001/0040).
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

  // Write mutation (`edit`+): undo a `deleteNode` Edge sweep — restores the Edges
  // stamped with the given deletionId. A lone `deleteEdge` mints no deletionId
  // and so has no `restoreEdge` handle. Wrapped in $transaction so the pre-check
  // and the updateMany sweep commit atomically. The `edit` capability ladder is
  // enforced in the service (ADR-0001/0040).
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

  // Write mutation (`edit`+): cascading soft-delete of a Component — its Node, its
  // subtree, and every incident/interior Connection — stamped with one deletionId
  // for undo. Wrapped in a transaction (like updatePositions) so the recursive
  // read and both sweeps commit atomically; the `edit` capability ladder is
  // enforced in the service (ADR-0001/0040).
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

  // Write mutation (`edit`+): undo a cascading delete, restoring exactly the rows
  // stamped with the given deletionId. The `edit` capability ladder is enforced in
  // the service (ADR-0001/0040).
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

  // Write-gated (`edit`+), READ-ONLY action: parse a pasted Spec and diff it
  // against the owner Component's existing generated children, returning the
  // classification that drives the conflict modal. A mutation (not a query)
  // because it's an imperative action over a large `source` body, never
  // reactive/cached data — and it writes nothing (cancel = zero writes; #64). The
  // `edit` capability ladder is enforced in the service (ADR-0001/0040).
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

  // Write mutation (`edit`+): apply a previewed Spec (create/overwrite/detach/
  // delete per the user's resolutions). Wrapped in a transaction so a per-row
  // reject rolls the whole merge back — never a partial apply (#64). The `edit`
  // capability ladder is enforced in the service (ADR-0001/0040). The raised
  // `timeout` is a margin for the
  // largest `source` we accept (`MAX_PARSED_NODES` Components + parse cost), NOT
  // the perf fix — `applySpec` bulk-inserts level by level so the work is a
  // handful of round trips, well under the default; the ceiling just absorbs a
  // worst-case parse on a cold connection. Same margin the MCP path uses.
  applySpec: protectedProcedure
    .input(applySpecInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await ctx.db.$transaction((tx) => applySpec(tx, actor, input), {
          timeout: BULK_WRITE_TIMEOUT_MS,
        });
      } catch (error) {
        throw toTRPCError(error);
      }
    }),
});
