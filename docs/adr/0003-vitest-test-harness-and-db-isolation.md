# 3. Vitest test harness with a real, isolated Postgres reset per test

## Status

Accepted

## Context

This milestone (M0) introduces the **first** automated test harness in the repo — `pnpm check`
(ESLint + `tsc --noEmit`) is currently the only validation gate, and there is no test runner.
The pattern we set here is the one every later slice inherits, so it is worth deciding
deliberately.

The thing we most need to test is the **service layer**: `(db, actor, input)` functions and the
`access` authorization rules (ADR-0001). The valuable assertion is *external behavior* — "a
non-owner mutation is rejected," "fetch-by-slug returns the Project," "create persists a row" —
not internal call shapes.

Three strategies were considered for giving services a database under test:

1. **Mock the Prisma client.** Fast, no infrastructure. But it asserts that we called Prisma a
   certain way, not that the behavior is correct; it cannot catch a wrong query, a bad unique
   constraint, or a real authorization slip. It tests our mock, not Postgres.
2. **Wrap each test in a transaction and roll back.** Clean isolation with no truncation cost —
   *if* the code under test never opens its own transaction. But the service layer's whole point
   is that `db` is injectable, and future services will call `db.$transaction(...)` internally.
   A nested transaction inside an outer test transaction does not behave like production, so the
   test would diverge from reality precisely where correctness matters most (and a partial-failure
   rollback could never be observed).
3. **A real, isolated Postgres, reset per test by truncating tables.** Tests run against actual
   Postgres with real constraints and real `$transaction` behavior; isolation comes from
   truncating all tables between tests rather than from an enclosing transaction.

## Decision

Adopt **Vitest** as the test runner, exposed via a `pnpm test` script, and use **strategy 3**:

- Tests run against a **real Postgres** instance, separate from the dev database, configured by a
  dedicated `.env.test` whose `DATABASE_URL` points at a distinct test database (a separate local
  database or a dedicated Neon branch). A safety guard refuses to run if that URL resolves to the
  **same database (host + name) as `.env`** (dev), so a test run can never truncate development
  data. (Matching on host + name rather than a "test" substring is what makes the guard work with
  Neon branches, which keep the same database name on a different host.)
- The injected `db` in tests is a Prisma client built directly from the test `DATABASE_URL` (via
  the same `@prisma/adapter-pg` driver adapter as `src/server/db.ts`) — it does **not** import the
  `~/server/db` singleton, so tests never trip the app's env validation. Services receive it
  through their `(db, actor, input)` signature — no global, no mock.
- Each test starts from a clean state via **truncation** of all application tables (a shared
  `resetDb` helper run in a `beforeEach` hook). This keeps real `db.$transaction(...)` semantics
  intact inside the code under test.
- The test database schema is synced once before the suite with `prisma db push` against the test
  `DATABASE_URL` (in Vitest's global setup). Test files run in a single fork (no cross-file
  parallelism) so per-test truncation is race-free.

## Consequences

- The `db` parameter of the service layer (ADR-0001) **is** the test seam — services are
  exercised directly, with no HTTP, no session, and no tRPC. This is why authorization had to be
  in the service layer and not the tRPC guard: it makes the security-critical logic unit-testable.
- Tests catch real database behavior: unique-constraint violations on `slug`, query mistakes, and
  genuine `$transaction` semantics that mocking and rollback-isolation would both hide.
- The trade is speed and a dependency on a running Postgres. Truncation per test (and a single
  fork) is slower than a rollback, and the database must be up. We accept this: correctness of the
  authorization and persistence layer is worth more than raw test speed.
- A separate test database is mandatory, not optional — pointing tests at the dev database would
  let a truncation wipe real data, which is why the guard hard-fails when the test URL matches the
  dev database.
- This sets the template: every later service slice tests against the same isolated-Postgres
  harness, asserting external behavior rather than implementation detail. Scaling beyond a single
  fork (e.g. schema-per-worker parallelism) is a later refinement.
