import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { ZodError } from "zod";

import { ArchitectureError } from "~/server/architecture/errors";

/**
 * The single, non-disclosing failure for any read the Actor cannot satisfy. A
 * project that does not exist and a project owned by someone else collapse to
 * the SAME message, so the MCP surface never reveals that a project id is real
 * but not yours (ADR-0002 — the posture `revokeApiToken` uses for foreign
 * tokens). Phrased so an honest agent learns the owner-scoping rule without the
 * response confirming whether the resource exists.
 */
const NOT_FOUND_MESSAGE =
  "Not found. This resource does not exist or is not accessible with your token. " +
  "You can only read projects owned by the user who minted the token.";

/**
 * Maps a service-layer error to the MCP error a read handler throws. NOT_FOUND
 * and FORBIDDEN are deliberately indistinguishable (non-disclosure); a malformed
 * address (a `BAD_REQUEST` from the service, or a Zod parse failure on the URI
 * variables) surfaces as `InvalidParams` so the agent can self-correct; anything
 * else is an opaque `InternalError` — an internal message is never leaked to the
 * agent. This is the symmetric partner to `trpc-errors.ts`, mapping the same
 * stable {@link ArchitectureError} codes to the MCP shape.
 */
export function toMcpReadError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  if (error instanceof ArchitectureError) {
    if (error.code === "BAD_REQUEST") {
      return new McpError(ErrorCode.InvalidParams, error.message);
    }
    // NOT_FOUND / FORBIDDEN / CONFLICT → one indistinguishable not-found.
    return new McpError(ErrorCode.InvalidParams, NOT_FOUND_MESSAGE);
  }
  if (error instanceof ZodError) {
    return new McpError(ErrorCode.InvalidParams, "Invalid resource address.");
  }
  return new McpError(
    ErrorCode.InternalError,
    "The request could not be completed.",
  );
}

/**
 * Maps a service-layer error to the MCP error a WRITE tool handler throws.
 * Mirrors {@link toMcpReadError}'s NOT_FOUND/FORBIDDEN non-disclosure, but —
 * unlike reads — keeps CONFLICT and BAD_REQUEST DISTINGUISHABLE so the agent can
 * self-correct:
 *
 * - CONFLICT and BAD_REQUEST surface the service's human message and (for
 *   CONFLICT) the structured `details` as `data.archDetails` — the same
 *   AI-readable channel the tRPC `errorFormatter` exposes
 *   (ADR-0010 named pattern). #19 ships four tools today, but the carrier is
 *   generic over {@link ConflictErrorDetails}, so #40 / #42's Flow / FlowRoute
 *   conflict ids ride through unchanged.
 * - NOT_FOUND and FORBIDDEN collapse to one non-disclosing failure — a missing
 *   project and a foreign project must not be distinguishable, the same posture
 *   reads use (ADR-0002 / ADR-0022). The owner-scoping rule is named in the
 *   message so an honest agent learns the constraint without confirmation that
 *   a specific id exists.
 * - Zod parse failures become `InvalidParams` so the agent can fix the call;
 *   anything else is an opaque `InternalError` — no internal message leaks.
 */
export function toMcpWriteError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  if (error instanceof ArchitectureError) {
    if (error.code === "NOT_FOUND" || error.code === "FORBIDDEN") {
      return new McpError(ErrorCode.InvalidParams, NOT_FOUND_MESSAGE);
    }
    // BAD_REQUEST and CONFLICT: keep the human message; CONFLICT also carries
    // structured `details` as `archDetails` (ADR-0010). The agent reads the id
    // arrays (`conflictingEdgeIds`, `conflictingFlowRouteIds`, …) to decide what
    // to mutate before retrying.
    return new McpError(
      ErrorCode.InvalidParams,
      error.message,
      error.details === undefined ? undefined : { archDetails: error.details },
    );
  }
  if (error instanceof ZodError) {
    return new McpError(ErrorCode.InvalidParams, "Invalid tool input.");
  }
  return new McpError(
    ErrorCode.InternalError,
    "The request could not be completed.",
  );
}
