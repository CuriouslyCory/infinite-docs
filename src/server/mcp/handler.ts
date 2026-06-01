import { createMcpHandler, withMcpAuth } from "mcp-handler";

import { db } from "~/server/db";
import { makeVerifyMcpToken } from "./auth";
import { registerArchitectureResources } from "./resources";
import { registerArchitectureTools } from "./tools";

/**
 * The authenticated MCP route — a thin adapter (ADR-0001): it resolves an
 * Actor from a bearer API token and exposes the read resources (#18) and the
 * write tools (#19), holding no business logic or authorization of its own.
 * `withMcpAuth({ required: true })` rejects any request without a valid token
 * before a resource or tool handler runs, so there is no anonymous access.
 *
 * Streamable HTTP only: SSE is disabled, so the legacy session/Redis path is
 * never reached — the route is stateless and needs zero new configuration.
 * `basePath: "/api"` makes the streamable endpoint resolve to `/api/mcp` (the
 * `[transport]` dynamic segment captures `mcp`).
 */
export function createArchitectureMcpHandler(): (
  req: Request,
) => Promise<Response> {
  const handler = createMcpHandler(
    (server) => {
      registerArchitectureResources(server, db);
      registerArchitectureTools(server, db);
    },
    { serverInfo: { name: "infinite-docs", version: "0.1.0" } },
    { basePath: "/api", disableSse: true },
  );
  return withMcpAuth(handler, makeVerifyMcpToken(db), { required: true });
}
