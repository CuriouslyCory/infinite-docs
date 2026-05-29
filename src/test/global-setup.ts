import { execSync } from "node:child_process";

import { config } from "dotenv";

import { assertSafeTestDatabase } from "./assert-test-db";

/**
 * Runs once before the whole suite: applies pending migrations against the
 * test database. The safety guard refuses to run unless DATABASE_URL points
 * at a database other than the dev one, so it can never touch dev data.
 *
 * `migrate deploy` (not `db push`) is mandatory because the partial unique
 * index `idx_edge_dedup` (ADR-0010) lives in a raw SQL migration that the
 * Prisma schema model cannot express. `db push` would sync the model but
 * silently omit the index, and the de-dupe race tests would pass for the
 * wrong reason (the service `findFirst` happens to win every interleaving in
 * a single-fork Vitest run). `migrate deploy` is idempotent and needs no
 * shadow DB. First run on a fresh test DB requires a one-time
 * `pnpm prisma migrate resolve --applied <baseline>` to mark the baseline
 * applied — only the second + later migrations actually execute.
 */
export default function setup(): void {
  config({ path: ".env.test", override: true });

  const databaseUrl = assertSafeTestDatabase(process.env.DATABASE_URL);

  try {
    execSync("pnpm prisma migrate deploy", {
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: databaseUrl },
      encoding: "utf-8",
    });
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    // eslint-disable-next-line no-console -- surface migrate failures in CI/CI logs
    console.error("[global-setup] migrate deploy failed:", {
      message: err.message,
      stdout: err.stdout,
      stderr: err.stderr,
    });
    throw error;
  }
}
