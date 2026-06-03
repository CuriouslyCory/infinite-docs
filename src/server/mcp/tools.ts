import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { PrismaClient } from "../../../generated/prisma/client";
import { actorFromAuthInfo } from "./auth";
import { toMcpWriteError } from "./errors";
import { WRITE_TOOLS } from "./tool-catalog";

/**
 * Registers the write tools (from the {@link WRITE_TOOLS} catalog) on a
 * per-request `McpServer`. Mirrors `registerArchitectureResources` — the
 * db handle is closed over, the Actor is read from each request's
 * `extra.authInfo` (resolved by `withMcpAuth`), and the service layer is
 * the only place authorization happens (ADR-0001 / ADR-0022).
 *
 * Takes the full {@link PrismaClient} (not the {@link Db}
 * `Prisma.TransactionClient` services accept) because each tool invocation
 * runs inside `db.$transaction(...)` — a single write tool may touch many
 * rows (move's subtree CTE + cycle check + the parentId update; connect's
 * find + insert; ADR-0014's cascade), and the transaction closes the
 * TOCTOU window the orphan/dedupe checks need. Adapter convention matches
 * the tRPC router (`ctx.db.$transaction((tx) => service(tx, actor, input))`).
 *
 * Errors flow through {@link toMcpWriteError}: NOT_FOUND/FORBIDDEN collapse
 * to one indistinguishable not-found (the read posture, ADR-0022); CONFLICT
 * and BAD_REQUEST keep their human message; CONFLICT additionally carries
 * the structured `details` as `data.archDetails` so the agent reads
 * `conflictingEdgeIds`/`conflictingClientIds`/… and self-corrects
 * (ADR-0010 named pattern).
 */
export function registerArchitectureTools(
  server: McpServer,
  db: PrismaClient,
): void {
  for (const descriptor of WRITE_TOOLS) {
    server.registerTool(
      descriptor.name,
      {
        title: descriptor.title,
        description: descriptor.description,
        inputSchema: descriptor.inputSchema,
        ...(descriptor.outputSchema
          ? { outputSchema: descriptor.outputSchema }
          : {}),
      },
      async (args, extra) => {
        const actor = actorFromAuthInfo(extra.authInfo);
        try {
          const result = await db.$transaction((tx) =>
            descriptor.invoke(tx, actor, args),
          );
          // When the descriptor declared an outputSchema, ride the typed
          // payload as MCP `structuredContent` so the agent gets a parsed
          // object on the wire (SDK 1.26.0) instead of re-parsing JSON out
          // of the text content. ADR-0026.
          const response: {
            content: { type: "text"; text: string }[];
            structuredContent?: Record<string, unknown>;
          } = {
            content: [{ type: "text", text: result.message }],
          };
          if (result.structured !== undefined) {
            response.structuredContent = result.structured as Record<
              string,
              unknown
            >;
          }
          return response;
        } catch (error) {
          throw toMcpWriteError(error);
        }
      },
    );
  }
}
