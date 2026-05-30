/**
 * Domain errors for the architecture service layer.
 *
 * These are framework-agnostic on purpose: services throw them, and each
 * transport adapter maps the stable `code` to its own error shape (tRPC ->
 * TRPCError now; MCP -> readable tool-error text later). Nothing here imports
 * a framework.
 */

export type ArchitectureErrorCode =
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "BAD_REQUEST";

export abstract class ArchitectureError extends Error {
  abstract readonly code: ArchitectureErrorCode;
  // Optional structured payload subclasses MAY carry (the AI-readable
  // companion to `message`). The tRPC errorFormatter exposes it to the
  // client as `error.data.archDetails`; the future MCP adapter reads it
  // directly off `cause`. Subclasses narrow this `unknown` to their own
  // type (e.g. `ConflictErrorDetails` on `ConflictError`).
  readonly details?: unknown;
}

export class ForbiddenError extends ArchitectureError {
  readonly code: ArchitectureErrorCode = "FORBIDDEN";

  constructor(message = "You do not have permission to perform this action.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

export class NotFoundError extends ArchitectureError {
  readonly code: ArchitectureErrorCode = "NOT_FOUND";

  constructor(message = "Resource not found.") {
    super(message);
    this.name = "NotFoundError";
  }
}

/**
 * Structured payload identifying what blocked the conflicting operation —
 * the AI-readable channel the human message cannot carry. Reaches the tRPC
 * client via the `errorFormatter` in `~/server/api/trpc.ts` (as
 * `error.data.archDetails`); the MCP adapter reads `cause.details` directly.
 * Additive: future Flow / FlowRoute / Node conflicts add their own keys here
 * without changing existing callers.
 */
export interface ConflictErrorDetails {
  // The active Edge(s) that block the write — e.g. the existing Connection a
  // duplicate `connectNodes` targets, or the rows holding triples a
  // `restoreNode` cannot revive (ADR-0010).
  conflictingEdgeIds?: string[];
  // The active Flow(s) that block the write — duplicate `(ownerNodeId, key)`
  // on `addFlow` / `attachFlowSpec`, or rows a `restoreNode` cannot revive
  // because the same owner/key slot is occupied (ADR-0010 named pattern,
  // ADR-0011).
  conflictingFlowIds?: string[];
  // The active FlowSpec(s) that block the write — a `restoreNode` whose
  // soft-deleted FlowSpec(s) cannot be revived because the same Component
  // (`ownerNodeId @unique`) now carries a fresh FlowSpec. Separate from
  // `conflictingFlowIds` because the collision is on different rows.
  conflictingFlowSpecIds?: string[];
}

/**
 * A request that conflicts with the current state — e.g. drawing a Connection
 * that already exists between the same source and target on the same Canvas
 * (the de-dupe rule, ADR-0005). Distinct from a malformed request
 * ({@link ValidationError}): the input is well-formed, but the operation is
 * not allowed given what is already there.
 *
 * Optional structured `details` carry an AI-readable companion to the human
 * message (e.g. `conflictingEdgeIds` for de-dupe conflicts; ADR-0010). The
 * tRPC `errorFormatter` flows them to `error.data.archDetails` on the client.
 */
export class ConflictError extends ArchitectureError {
  readonly code: ArchitectureErrorCode = "CONFLICT";
  readonly details?: ConflictErrorDetails;

  constructor(message?: string, details?: ConflictErrorDetails) {
    super(message ?? "That action conflicts with the current state.");
    this.name = "ConflictError";
    this.details = details;
  }
}

/**
 * A semantically invalid request that Zod cannot catch on its own — e.g. a
 * self-Connection (source === target) or endpoints that do not sit on the
 * Canvas the Connection is drawn on (ADR-0005). The shape is valid; the meaning
 * is not.
 */
export class ValidationError extends ArchitectureError {
  readonly code: ArchitectureErrorCode = "BAD_REQUEST";

  constructor(message = "That request is not valid.") {
    super(message);
    this.name = "ValidationError";
  }
}
