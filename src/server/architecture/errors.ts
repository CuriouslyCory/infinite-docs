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
 * A request that conflicts with the current state — e.g. drawing a Connection
 * that already exists between the same source and target on the same Canvas
 * (the de-dupe rule, ADR-0005). Distinct from a malformed request
 * ({@link ValidationError}): the input is well-formed, but the operation is
 * not allowed given what is already there.
 */
export class ConflictError extends ArchitectureError {
  readonly code: ArchitectureErrorCode = "CONFLICT";

  constructor(message = "That action conflicts with the current state.") {
    super(message);
    this.name = "ConflictError";
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
