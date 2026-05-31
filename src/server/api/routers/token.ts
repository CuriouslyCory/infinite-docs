import { createTRPCRouter, protectedProcedure } from "~/server/api/trpc";
import { type Actor } from "~/server/architecture/actor";
import {
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from "~/server/architecture/token.service";
import { createApiTokenInput, revokeApiTokenInput } from "~/lib/schemas";
import { toTRPCError } from "~/server/architecture/trpc-errors";

/**
 * Thin adapter over the API-token service layer: resolve an Actor, call the
 * service, map domain errors to TRPCErrors. No business logic and no direct
 * `ctx.db` access live here (ADR-0001). Tokens are an account concern (not graph
 * architecture), so they get their own router rather than growing
 * `architectureRouter`. All procedures are owner-only (`protectedProcedure`) —
 * minting/listing/revoking your own tokens is never slug-granted (ADR-0002).
 */
export const tokenRouter = createTRPCRouter({
  create: protectedProcedure
    .input(createApiTokenInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await createApiToken(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),

  list: protectedProcedure.query(async ({ ctx }) => {
    const actor: Actor = { userId: ctx.session.user.id, via: "session" };
    try {
      return await listApiTokens(ctx.db, actor);
    } catch (error) {
      throw toTRPCError(error);
    }
  }),

  revoke: protectedProcedure
    .input(revokeApiTokenInput)
    .mutation(async ({ ctx, input }) => {
      const actor: Actor = { userId: ctx.session.user.id, via: "session" };
      try {
        return await revokeApiToken(ctx.db, actor, input);
      } catch (error) {
        throw toTRPCError(error);
      }
    }),
});
