import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import type { Actor, Db } from "~/server/architecture/actor";
import { resolveActorFromToken } from "~/server/architecture/token.service";

/**
 * Builds the `withMcpAuth` verifier bound to a db handle. It resolves the
 * presented bearer token to an Actor and, on success, returns the MCP SDK's
 * `AuthInfo` carrying the `userId` in `extra` — the only identity the resource
 * handlers need. Returning `undefined` makes `withMcpAuth({ required: true })`
 * reject with a single 401; every failure mode (missing, unknown, revoked,
 * expired) collapses to the same rejection inside `resolveActorFromToken`, so
 * which check failed is never disclosed (ADR-0002). The adapter never touches
 * the HMAC — hashing lives in the service layer (ADR-0001).
 */
export function makeVerifyMcpToken(db: Db) {
  return async function verifyMcpToken(
    _req: Request,
    bearerToken?: string,
  ): Promise<AuthInfo | undefined> {
    const actor = await resolveActorFromToken(db, bearerToken);
    if (!actor) return undefined;
    return {
      token: bearerToken ?? "",
      clientId: actor.userId,
      scopes: actor.scopes ?? [],
      extra: { userId: actor.userId, via: actor.via },
    };
  };
}

/**
 * Reconstructs the service-layer Actor from the `AuthInfo` that `withMcpAuth`
 * stashed and the SDK threaded into each resource handler's `extra`. Authz is
 * always derived from `userId` (ADR-0001); `scopes` ride along but never gate.
 * Throws if reached without a resolved identity — `withMcpAuth({ required })`
 * guarantees this cannot happen on the live route, so it is a defensive
 * invariant for a mis-wired caller, not a reachable user path.
 */
export function actorFromAuthInfo(authInfo: AuthInfo | undefined): Actor {
  const userId = authInfo?.extra?.userId;
  if (typeof userId !== "string") {
    throw new Error(
      "MCP resource handler reached without a resolved Actor (auth not enforced upstream).",
    );
  }
  return { userId, via: "token", scopes: authInfo?.scopes };
}
