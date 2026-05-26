import { PrismaPg } from "@prisma/adapter-pg";

import { assertSafeTestDatabase } from "../../../../test/assert-test-db";
import { PrismaClient } from "../../../../../generated/prisma/client";

// Build a client directly from process.env (populated by setup-env.ts) rather
// than importing ~/server/db — that singleton imports ~/env, whose validation
// would require unrelated auth secrets just to run a service test. The guard
// refuses any URL that matches the dev database (see assert-test-db.ts).
const connectionString = assertSafeTestDatabase(process.env.DATABASE_URL);

export const testDb = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

/** Resets the database to a clean state between tests (see docs/adr/0003). */
export async function resetDb(): Promise<void> {
  await testDb.$executeRawUnsafe(
    `TRUNCATE TABLE "Node", "Project", "Post", "Session", "Account", "VerificationToken", "User" RESTART IDENTITY CASCADE;`,
  );
}
