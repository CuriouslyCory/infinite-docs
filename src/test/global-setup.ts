import { execSync } from "node:child_process";

import { config } from "dotenv";

import { assertSafeTestDatabase } from "./assert-test-db";

/**
 * Runs once before the whole suite: sync the test database schema with
 * `prisma db push`. The safety guard refuses to run unless DATABASE_URL points
 * at a database other than the dev one, so it can never truncate dev data.
 */
export default function setup(): void {
  config({ path: ".env.test", override: true });

  const databaseUrl = assertSafeTestDatabase(process.env.DATABASE_URL);

  // prisma.config.ts resolves the URL from process.env via dotenv, which does
  // not override an already-set value — so the explicit DATABASE_URL wins.
  // (Prisma 7's `db push` only syncs the schema; `generate` is decoupled.)
  execSync("pnpm prisma db push", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}
