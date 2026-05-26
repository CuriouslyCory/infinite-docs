import { config } from "dotenv";

/**
 * Guards against running the (truncating) test suite on the dev/production
 * database. The test DATABASE_URL must resolve to a different database than
 * `.env` (dev) — compared by host + database name, so it works with Neon
 * branches (which keep the same database name on a different host). Throws if
 * the test URL is missing or matches the dev database.
 */
export function assertSafeTestDatabase(testUrl: string | undefined): string {
  if (!testUrl) {
    throw new Error(
      "DATABASE_URL is not set for tests. Copy .env.test.example to .env.test.",
    );
  }
  // Read the dev URL from .env without mutating process.env.
  const devUrl = config({ path: ".env", processEnv: {} }).parsed?.DATABASE_URL;
  if (devUrl && databaseIdentity(devUrl) === databaseIdentity(testUrl)) {
    throw new Error(
      "Refusing to run tests: .env.test points at the same database as .env " +
        "(dev). Use a separate database or Neon branch for tests.",
    );
  }
  return testUrl;
}

function databaseIdentity(connectionString: string): string {
  const url = new URL(connectionString);
  return `${url.hostname}${url.pathname}`;
}
