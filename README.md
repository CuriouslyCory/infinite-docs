# Infinite Docs

A drag-and-drop tool for documenting software architecture as an **infinitely-nestable graph**.

You place **Components** on a **Canvas** and link them with **Connections**. Opening a Component
descends into its own interior Canvas, recursing to any depth — from top-level infrastructure
(hosts, databases, external APIs) down to internal services, modules, or individual tables. The
external systems a Component connects to follow you inward as read-only **boundary proxies**, so
dependency context is never lost on the way down. Every Component carries markdown documentation,
the whole graph serializes to deterministic markdown for LLM consumption, and an authenticated
**MCP server** lets AI agents read and maintain the architecture as they work on the system it
describes.

## Why

Existing tools force a choice no one should have to make:

- **Static diagrams** (Visio, Lucid, draw.io) produce pictures that rot the moment the system
  changes, can't be drilled into, and carry no real documentation.
- **Text docs and wikis** capture detail but lose the spatial, relational picture — you can't
  *see* how infrastructure, services, and data connect.
- **Neither feeds cleanly into an LLM**, and none let an AI agent *read and maintain* the
  architecture as it works on the actual system.

Infinite Docs is a single place to model a system at *any depth*, keep it alive as the system
evolves, and hand it to both people and agents as a first-class artifact.

## Core concepts

[`CONTEXT.md`](CONTEXT.md) is the binding glossary — the source of truth for vocabulary. The
essentials:

| Term | What it is |
| --- | --- |
| **Component** / Node | The unit of architecture you place, name, document, and open. *Component* is the user-facing word; *Node* is its data-model name. |
| **Connection** / Edge | A link between two Components. *Connection* is user-facing; *Edge* is the data-model name. |
| **Canvas** | A *derived* view — the Components and Connections that live under one parent. Never stored directly. |
| **Descent** | Opening a Component to enter its interior Canvas, one level deeper, recursing to any depth. |
| **Boundary proxy** | A read-only stand-in for an external system a parent depends on, projected inward and inherited transitively down the subtree. |
| **Project** | The root container of one architecture graph, owned by a single user. |
| **Capability URL** | An unguessable per-Project slug whose mere possession grants read access. Mutations always require the signed-in owner. |
| **Service layer** | The single deep module — `(db, actor, input) => result` — that is the only home for business logic and authorization. tRPC and MCP are thin adapters over it. |

The `Component`/`Node` and `Connection`/`Edge` split is deliberate: "node" is overloaded in this
stack (Node.js, the canvas library), so humans and agents say **Component**/**Connection** while
the schema, services, and graph algorithms say **Node**/**Edge**.

## Project status

The product is sequenced across milestones M0–M5; the full vision lives in the PRD
([issue #2](https://github.com/CuriouslyCory/infinite-docs/issues/2)).

| Milestone | Scope | Status |
| --- | --- | --- |
| **M0** | Data model + `(db, actor, input)` service layer + Vitest harness | Complete |
| **M1** | First nested Canvas: create / drag / connect / rename / descend, soft-delete + undo | Complete |
| **M2** | Markdown export + in-app documentation editor | Planned |
| **M3** | Boundary propagation (read-only proxies, inherited transitively) | Planned |
| **M4** | MCP server: agent tokens, tools, resources, `llms.txt`, "Connect an agent" | Planned |
| **M5** | Refinement-edge wiring, auto-layout, sharing polish | Planned |

**Working today:** sign in with Discord, create and list Projects, open a Project by its
capability URL, and on its Canvas add Components (six kinds — service, database, external API,
host, queue, generic), drag them, rename them inline, draw / label / remove
Connections (with a structural arrow that always points at the input **Port**), **descend** into
a Component's interior Canvas with breadcrumb navigation, and
**delete** a Component — cascading to its whole subtree and every incident or interior
Connection — with one-click **undo**. Every edit is optimistic: it appears instantly and persists
in the background, with rollback and a toast on failure. **Next up (M2):** markdown export and an
in-app documentation editor.

## Stack

T3 Stack: **Next.js 16** (App Router + React Server Components), **tRPC v11**, **Prisma 7**
(PostgreSQL), **NextAuth v5** (Discord), **Tailwind v4**, **TypeScript** (strict), **Zod**, and
**React Flow** ([`@xyflow/react`](https://reactflow.dev)) for the Canvas. Package manager is
**pnpm** (pinned in `packageManager`).

A few architectural notes worth knowing before you dig in:

- The **Prisma client is generated to `generated/prisma`** (git-ignored; regenerated on install
  via `postinstall`), not `node_modules`. Always go through the singleton at `~/server/db` — never
  import `@prisma/client` directly.
- **Environment variables are schema-validated** in `src/env.js` (`@t3-oss/env-nextjs` + Zod); an
  invalid or missing var fails the build.
- The **Canvas is a client-only island** — dynamically imported with SSR disabled, since the
  diagramming library is not server-renderable (see [ADR-0004](docs/adr/0004-canvas-ssr-disabled-island.md)).

## Getting started

**Prerequisites:** Node.js, [pnpm](https://pnpm.io), and PostgreSQL (a local instance, Docker, or
a hosted branch such as [Neon](https://neon.tech)).

1. **Install dependencies** (also runs `prisma generate` via `postinstall`):

   ```bash
   pnpm install
   ```

2. **Configure environment.** Copy the example and fill it in:

   ```bash
   cp .env.example .env
   ```

   - `AUTH_SECRET` — generate one with `npx auth secret`.
   - `AUTH_DISCORD_ID` / `AUTH_DISCORD_SECRET` — from a
     [Discord OAuth application](https://discord.com/developers/applications).
   - `DATABASE_URL` — your Postgres connection string.

3. **Start Postgres** (skip if you already have one). The bundled script spins up a local
   container:

   ```bash
   ./start-database.sh
   ```

4. **Apply the schema migrations** to your database:

   ```bash
   pnpm db:migrate
   ```

   This runs `prisma migrate deploy`, which is idempotent and the only supported schema-sync command per ADR-0010 (it applies the raw-SQL partial unique index that `db push` cannot).

5. **Run the dev server:**

   ```bash
   pnpm dev
   ```

   Open the app, sign in with Discord, create a Project, and start modeling on its Canvas.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Dev server (Turbopack) |
| `pnpm check` | `eslint .` + `tsc --noEmit` — the primary validation gate |
| `pnpm typecheck` | Types only |
| `pnpm lint` / `pnpm lint:fix` | ESLint |
| `pnpm format:write` / `pnpm format:check` | Prettier |
| `pnpm test` / `pnpm test:watch` | Vitest (see below) |
| `pnpm build` / `pnpm preview` | Production build / build + start |
| `pnpm db:author <name>` | Scaffold a migration directory seeded with the live-DB-to-schema diff (hand-edit for raw SQL afterwards) |
| `pnpm db:check` | Drift gate: prints the SQL diff and exits 2 if `prisma/schema.prisma` is ahead of the live DB |
| `pnpm db:migrate` | `prisma migrate deploy && prisma generate` — apply pending migrations and refresh the client (dev, test, prod) per [ADR-0010](docs/adr/0010-edge-dedup-partial-unique-index.md) |
| `pnpm db:studio` | Prisma Studio |

Authoring a new migration: run `pnpm db:author <name>` (e.g. `pnpm db:author add_flow_models`); it creates `prisma/migrations/<ts>_<name>/migration.sql` populated with the live-DB-to-schema diff. Hand-edit for any raw SQL Prisma cannot express (partial unique indexes, `DO $$` guards), then apply with `pnpm db:migrate` (which deploys and regenerates the client). The author/check commands diff against the live dev DB rather than the migration history because `--from-migrations` would require a shadow DB this repo deliberately does not configure — so the dev DB must be at the head of migrations first (run `pnpm db:migrate` if it has fallen behind). Never use `prisma migrate dev` (needs a shadow DB) or `prisma db push` (desyncs migration history) — see ADR-0010.

> `pnpm check` cannot catch a client/server bundle leak or a query waterfall — for Canvas and
> data-layer changes, **verify by running the app**, not just by checking.

## Testing

Tests run with [Vitest](https://vitest.dev) against a **real, isolated Postgres** database — not
mocks. The `(db, actor, input)` service layer is the deliberate testable seam: tests inject a real
database and exercise services directly, asserting *external behavior* (returned value + resulting
database state), never internal query structure. Each test truncates the database to start clean,
so tests must use a **separate** database from your dev data. See
[ADR-0003](docs/adr/0003-vitest-test-harness-and-db-isolation.md) for the rationale.

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

   Vitest's global setup applies pending migrations to the test database with `prisma migrate
   deploy` before the suite runs (idempotent; no shadow DB). Per ADR-0010, `db push` is not used
   because it would silently skip the raw-SQL partial unique index `idx_edge_dedup` that backstops
   the Edge de-dupe rule. On a fresh test DB, run `pnpm prisma migrate resolve --applied <baseline>`
   once to mark the baseline applied before the first `pnpm test`.

## Project layout

- `src/server/architecture/` — the **service layer** (`project`, `node`, `edge` services, plus
  `access`, `actor`, `slug`, and error mapping). The only home for business logic and authorization.
- `src/server/api/routers/architecture.ts` — the tRPC adapter: resolves an `actor`, calls the
  service, maps domain errors to `TRPCError`s. No business logic here.
- `src/lib/schemas.ts` — Zod input schemas, importable as values from client code without pulling
  in the server graph.
- `src/app/p/[slug]/` — the Project route and the Canvas island (React Flow custom nodes/edges).
- `prisma/schema.prisma` — the `Project` / `Node` / `Edge` models and the `NodeKind` enum.
- [`CONTEXT.md`](CONTEXT.md) — the binding glossary.
- [`docs/adr/`](docs/adr/) — architecture decision records (service layer, capability-URL sharing,
  test harness, Canvas island, edge scope & invariants).
- [`docs/agents/`](docs/agents/) — agent workflow docs (issue tracker, triage labels, domain docs).

## Deploying

Follow the T3 deployment guides for [Vercel](https://create.t3.gg/en/deployment/vercel),
[Netlify](https://create.t3.gg/en/deployment/netlify), or
[Docker](https://create.t3.gg/en/deployment/docker). Remember that `src/env.js` validates every
environment variable at build time — set `SKIP_ENV_VALIDATION` to bypass it (e.g. in Docker
builds where vars are injected at runtime).
