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
