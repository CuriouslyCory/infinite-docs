/**
 * Domain errors for the architecture service layer.
 *
 * These are framework-agnostic on purpose: services throw them, and each
 * transport adapter maps the stable `code` to its own error shape (tRPC ->
 * TRPCError now; MCP -> readable tool-error text later). Nothing here imports
 * a framework.
 */

export type ArchitectureErrorCode = "FORBIDDEN" | "NOT_FOUND";

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
