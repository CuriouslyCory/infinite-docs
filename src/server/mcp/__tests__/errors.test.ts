import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "~/server/architecture/errors";

import { toMcpWriteError } from "../errors";

describe("toMcpWriteError", () => {
  it("collapses NOT_FOUND to one indistinguishable non-disclosing message", () => {
    const error = toMcpWriteError(new NotFoundError("internal hint"));

    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(ErrorCode.InvalidParams);
    expect(error.message).not.toContain("internal hint");
    // The agent learns the owner-scoping rule from the canonical message,
    // not a leak about whether the addressed resource exists.
    expect(error.message).toContain("You can only read projects");
  });

  it("collapses FORBIDDEN to the SAME message as NOT_FOUND (non-disclosure parity)", () => {
    const notFoundMessage = toMcpWriteError(new NotFoundError()).message;
    const forbiddenMessage = toMcpWriteError(new ForbiddenError()).message;
    // Identical strings: a foreign-owned project and a missing project must
    // not be distinguishable from the agent's perspective (ADR-0022).
    expect(forbiddenMessage).toBe(notFoundMessage);
  });

  it("preserves the human message for BAD_REQUEST and carries no archDetails", () => {
    const error = toMcpWriteError(
      new ValidationError("A Component cannot be moved under itself."),
    );

    expect(error.code).toBe(ErrorCode.InvalidParams);
    // `McpError.message` prepends "MCP error -<code>: " to the supplied text
    // (SDK convention); assert containment of the canonical text rather than
    // exact equality so a future SDK prefix change cannot silently mask a real
    // message regression.
    expect(error.message).toContain(
      "A Component cannot be moved under itself.",
    );
    expect(error.data).toBeUndefined();
  });

  it("preserves the human message AND attaches structured details for CONFLICT", () => {
    const conflict = new ConflictError(
      "Disconnect the Connection first, then move.",
      { conflictingEdgeIds: ["edge-1", "edge-2"] },
    );

    const error = toMcpWriteError(conflict);

    expect(error.code).toBe(ErrorCode.InvalidParams);
    expect(error.message).toContain(
      "Disconnect the Connection first, then move.",
    );
    // Generic carrier: the SAME envelope plugs in for future Flow / FlowRoute
    // conflicts (#40 / #42) without changing this adapter. The agent reads
    // `data.archDetails.conflictingEdgeIds` (or any other ConflictErrorDetails
    // key) and self-corrects.
    expect(error.data).toEqual({
      archDetails: { conflictingEdgeIds: ["edge-1", "edge-2"] },
    });
  });

  it("does not attach archDetails when a ConflictError carries no details", () => {
    const error = toMcpWriteError(new ConflictError("Generic conflict."));

    expect(error.code).toBe(ErrorCode.InvalidParams);
    expect(error.message).toContain("Generic conflict.");
    expect(error.data).toBeUndefined();
  });

  it("maps Zod parse failures to a stable 'invalid input' message", () => {
    const parseFailure = z
      .object({ id: z.string().min(1) })
      .safeParse({ id: "" });
    if (parseFailure.success) {
      throw new Error("expected the schema to reject an empty id");
    }

    const error = toMcpWriteError(parseFailure.error);

    expect(error.code).toBe(ErrorCode.InvalidParams);
    expect(error.message).toContain("Invalid tool input.");
  });

  it("opaque InternalError for anything else (no internal message leaks)", () => {
    const error = toMcpWriteError(new Error("DATABASE_URL exposed in stack"));

    expect(error.code).toBe(ErrorCode.InternalError);
    expect(error.message).not.toContain("DATABASE_URL");
    expect(error.message).toContain("The request could not be completed.");
  });

  it("passes a pre-built McpError through unchanged (so a tool handler can shortcut)", () => {
    const original = new McpError(
      ErrorCode.InvalidRequest,
      "already shaped for MCP",
    );

    const result = toMcpWriteError(original);

    expect(result).toBe(original);
  });
});
