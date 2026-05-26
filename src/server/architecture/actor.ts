import type { Prisma } from "../../../generated/prisma/client";

/**
 * The resolved identity of whoever is calling a service function. Constructed
 * at the edge (a tRPC procedure resolves it from the session; the future MCP
 * path resolves it from a token) and passed as the second argument to every
 * service function.
 *
 * Authorization is derived ONLY from `userId`. `via`/`scopes` are never used to
 * make an authz decision (see CONTEXT.md and docs/adr/0001).
 */
export interface Actor {
  userId: string;
  scopes?: string[];
  via?: "session" | "token";
}

/**
 * The database handle services accept. Typed as `Prisma.TransactionClient` (the
 * client surface shared by the full `PrismaClient` and an interactive
 * transaction client) so a future service can run inside `db.$transaction(...)`
 * and pass the `tx` into these same functions without a signature change.
 *
 * Services never import the `~/server/db` singleton — `db` is always injected,
 * which keeps them testable and free of the server-graph bundle.
 */
export type Db = Prisma.TransactionClient;
