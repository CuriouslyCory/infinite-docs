# Create T3 App

This is a [T3 Stack](https://create.t3.gg/) project bootstrapped with `create-t3-app`.

## What's next? How do I make an app with this?

We try to keep this project as simple as possible, so you can start with just the scaffolding we set up for you, and add additional things later when they become necessary.

If you are not familiar with the different technologies used in this project, please refer to the respective docs. If you still are in the wind, please join our [Discord](https://t3.gg/discord) and ask for help.

- [Next.js](https://nextjs.org)
- [NextAuth.js](https://next-auth.js.org)
- [Prisma](https://prisma.io)
- [Drizzle](https://orm.drizzle.team)
- [Tailwind CSS](https://tailwindcss.com)
- [tRPC](https://trpc.io)

## Learn More

To learn more about the [T3 Stack](https://create.t3.gg/), take a look at the following resources:

- [Documentation](https://create.t3.gg/)
- [Learn the T3 Stack](https://create.t3.gg/en/faq#what-learning-resources-are-currently-available) — Check out these awesome tutorials

You can check out the [create-t3-app GitHub repository](https://github.com/t3-oss/create-t3-app) — your feedback and contributions are welcome!

## Running tests

Tests run with [Vitest](https://vitest.dev) against a **real, isolated Postgres** database — not
mocks. Each test truncates the database to start clean, so tests must use a **separate** database
from your dev data. See [ADR-0003](docs/adr/0003-vitest-test-harness-and-db-isolation.md) for the
rationale.

1. **Configure the test database.** Copy `.env.test.example` to `.env.test` and set its
   `DATABASE_URL` to a database **separate** from the one in `.env` — a local database or a
   dedicated [Neon branch](https://neon.tech/docs/guides/branching-intro). The harness refuses to
   run if it resolves to the same database (host + name) as `.env`, so a test run can never wipe
   your dev data.

2. **(Local Postgres only)** start it and create the database, e.g.:

   ```bash
   ./start-database.sh             # starts a local Postgres container
   createdb infinite-docs-test     # or: psql -c 'CREATE DATABASE "infinite-docs-test";'
   ```

   With a Neon branch you can skip this step — the branch already exists.

3. **Run the tests:**

   ```bash
   pnpm test
   ```

   Vitest's global setup syncs the schema to the test database with `prisma db push` before the
   suite runs, so there is no separate migrate step.

## How do I deploy this?

Follow our deployment guides for [Vercel](https://create.t3.gg/en/deployment/vercel), [Netlify](https://create.t3.gg/en/deployment/netlify) and [Docker](https://create.t3.gg/en/deployment/docker) for more information.
