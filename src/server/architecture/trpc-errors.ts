import { TRPCError } from "@trpc/server";

import { ArchitectureError } from "./errors";

/**
 * Translates a domain error into the matching TRPCError. This is the only file
 * in the architecture service layer permitted to import `@trpc/server`; the
 * future MCP adapter maps the same {@link ArchitectureError.code} to its own
 * tool-error shape without touching this file.
 *
 * Structured `details` on the cause (e.g. `ConflictError.conflictingEdgeIds`)
 * flow through to the client via the tRPC `errorFormatter` in
 * `~/server/api/trpc.ts`, which exposes them as `error.data.archDetails`
 * (ADR-0010). No per-code mapping needed here — `cause: error` carries them.
 */
export function toTRPCError(error: unknown): TRPCError {
  if (error instanceof TRPCError) {
    return error;
  }
  if (error instanceof ArchitectureError) {
    switch (error.code) {
      case "FORBIDDEN":
        return new TRPCError({
          code: "FORBIDDEN",
          message: error.message,
          cause: error,
        });
      case "NOT_FOUND":
        return new TRPCError({
          code: "NOT_FOUND",
          message: error.message,
          cause: error,
        });
      case "CONFLICT":
        return new TRPCError({
          code: "CONFLICT",
          message: error.message,
          cause: error,
        });
      case "BAD_REQUEST":
        return new TRPCError({
          code: "BAD_REQUEST",
          message: error.message,
          cause: error,
        });
    }
  }
  return new TRPCError({ code: "INTERNAL_SERVER_ERROR", cause: error });
}
