import { TRPCError, type TRPCDefaultErrorShape } from "@trpc/server";
import { z, type ZodError } from "zod";
import { describe, expect, it } from "vitest";

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../architecture/errors";
import { trpcErrorFormatter } from "../error-formatter";

// A minimal valid DefaultErrorShape — the formatter shape-spreads it and
// reads only the `data` field. Path is left undefined to match the wire
// shape when no procedure context exists (server-side raw call).
function baseShape(): TRPCDefaultErrorShape {
  return {
    message: "test",
    code: -32600,
    data: {
      code: "BAD_REQUEST",
      httpStatus: 400,
      path: undefined,
      stack: undefined,
    },
  };
}

function format(error: TRPCError) {
  return trpcErrorFormatter({ shape: baseShape(), error });
}

describe("trpcErrorFormatter", () => {
  it("flows ConflictError.details to shape.data.archDetails", async () => {
    // The contract the rich-diagnostic ConflictError relies on (ADR-0010):
    // structured `details` on the cause must reach the client unchanged.
    // Without this, the UI / future MCP adapter only sees the human message.
    const conflict = new ConflictError("That Connection already exists.", {
      conflictingEdgeIds: ["edge_abc", "edge_def"],
    });
    const trpcError = new TRPCError({
      code: "CONFLICT",
      message: conflict.message,
      cause: conflict,
    });

    const result = format(trpcError);

    expect(result.data.archDetails).toEqual({
      conflictingEdgeIds: ["edge_abc", "edge_def"],
    });
  });

  it("emits archDetails: undefined when ConflictError carries no details", () => {
    // ConflictError with no details still goes through the architecture path
    // — `details` is optional and may be absent on legacy throws.
    const conflict = new ConflictError("That action conflicts.");
    const trpcError = new TRPCError({
      code: "CONFLICT",
      message: conflict.message,
      cause: conflict,
    });

    const result = format(trpcError);

    expect(result.data.archDetails).toBeUndefined();
  });

  it("emits archDetails: null when the cause is not an ArchitectureError", () => {
    // Anything other than an ArchitectureError on the cause leaves
    // archDetails null — a plain Error, a non-arch domain error, or no cause.
    const trpcError = new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "kaboom",
      cause: new Error("boom"),
    });

    const result = format(trpcError);

    expect(result.data.archDetails).toBeNull();
  });

  it("flows other ArchitectureError subclasses too (NotFound, Forbidden)", () => {
    // ArchitectureError.details is declared on the base, so any subclass
    // that grows structured details in the future inherits the wire path.
    const notFound = format(
      new TRPCError({ code: "NOT_FOUND", cause: new NotFoundError() }),
    );
    const forbidden = format(
      new TRPCError({ code: "FORBIDDEN", cause: new ForbiddenError() }),
    );
    expect(notFound.data.archDetails).toBeUndefined();
    expect(forbidden.data.archDetails).toBeUndefined();
  });

  it("still surfaces zodError alongside archDetails", () => {
    // The two channels are independent: the formatter must not regress the
    // pre-existing ZodError pass-through when adding archDetails.
    let zodError: ZodError;
    try {
      z.object({ name: z.string() }).parse({ name: 1 });
      throw new Error("zod schema should have rejected");
    } catch (e) {
      zodError = e as ZodError;
    }
    const trpcError = new TRPCError({
      code: "BAD_REQUEST",
      message: "validation",
      cause: zodError,
    });

    const result = format(trpcError);

    expect(result.data.zodError).not.toBeNull();
    expect(result.data.archDetails).toBeNull();
  });
});
