import { createArchitectureMcpHandler } from "~/server/mcp/handler";

// Node runtime: the token HMAC (`node:crypto`) and the Prisma pg adapter are
// Node-only, and an edge default would break both at runtime — invisibly to
// `pnpm check` (verify by running). The MCP read route speaks Streamable HTTP;
// this `[transport]` segment funnels /api/mcp (and /api/sse, /api/message) into
// the one handler, which matches on pathname and 405s the non-POST methods.
export const runtime = "nodejs";

const handler = createArchitectureMcpHandler();

export { handler as GET, handler as POST, handler as DELETE };
