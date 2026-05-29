import type { TRPCError, TRPCDefaultErrorShape } from "@trpc/server";
import { ZodError } from "zod";

import { ArchitectureError } from "~/server/architecture/errors";

/**
 * Shape of the structured channels this app's tRPC errors carry alongside
 * the default `code`/`message`. The client reads these via `error.data.*`
 * on a TRPCClientError.
 */
export type AppErrorShape = TRPCDefaultErrorShape & {
  data: TRPCDefaultErrorShape["data"] & {
    zodError: ReturnType<ZodError["flatten"]> | null;
    archDetails: unknown;
  };
};

/**
 * Shapes every tRPC error for the client. Surfaces two structured channels
 * alongside the default code/message:
 *
 *   - `zodError`: flattened ZodError when the cause is a Zod validation
 *     failure, so the client can display per-field messages.
 *   - `archDetails`: `ArchitectureError.details` (e.g.
 *     `ConflictError.details.conflictingEdgeIds`; ADR-0010), the AI-readable
 *     companion to the human message. The MCP adapter reads `cause.details`
 *     directly; this formatter is the web path.
 *
 * Lives in its own file (rather than `trpc.ts`) so unit tests can import it
 * without pulling in `~/server/auth` and the Next.js server runtime that
 * `trpc.ts` transitively depends on.
 */
export function trpcErrorFormatter(opts: {
  shape: TRPCDefaultErrorShape;
  error: TRPCError;
}): AppErrorShape {
  const { shape, error } = opts;
  const archDetails =
    error.cause instanceof ArchitectureError ? error.cause.details : null;
  return {
    ...shape,
    data: {
      ...shape.data,
      zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
      archDetails,
    },
  };
}
