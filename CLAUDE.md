# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

T3 Stack app: Next.js 15 (App Router + React Server Components), tRPC v11, Prisma 6 (PostgreSQL), NextAuth v5 (beta) with Discord, Tailwind v4, TypeScript (strict), Zod. Package manager is **pnpm** (pinned in `packageManager`) — do not use npm/yarn.

## Commands

- `pnpm dev` — dev server (Turbopack)
- `pnpm check` — `next lint` + `tsc --noEmit`; the primary validation gate (there is no test runner configured)
- `pnpm typecheck` — types only
- `pnpm lint` / `pnpm lint:fix`
- `pnpm format:write` / `pnpm format:check` — Prettier
- `pnpm build` / `pnpm preview` (build + start)

Database:

- `./start-database.sh` — spin up local Postgres in Docker/Podman (parses `DATABASE_URL` from `.env`; offers to replace the default password)
- `pnpm db:push` — push schema to the DB without a migration (fast iteration)
- `pnpm db:generate` — `prisma migrate dev` (create + apply a migration)
- `pnpm db:migrate` — `prisma migrate deploy` (apply migrations, prod)
- `pnpm db:studio` — Prisma Studio

There are no automated tests in this repo; `pnpm check` is the closest thing to CI validation.

## Architecture

### Prisma client lives in a non-standard location

The Prisma client is generated to **`generated/prisma`** (see `prisma/schema.prisma` `generator.output`), not `node_modules`. Always access the database through the singleton at `~/server/db` (which imports `PrismaClient` from `../../generated/prisma`) — never import from `@prisma/client`. The `generated/` directory is committed to git and is excluded from tsconfig/ESLint; `postinstall` runs `prisma generate` to refresh it.

### Environment variables are schema-validated

`src/env.js` validates all env vars with `@t3-oss/env-nextjs` + Zod, split into `server` and `client` (client vars must be prefixed `NEXT_PUBLIC_`). `next.config.js` imports it, so an invalid/missing var fails the build. **To add a variable you must edit `src/env.js` in two places: the schema (`server`/`client`) and `runtimeEnv`.** Set `SKIP_ENV_VALIDATION` to bypass (e.g. Docker builds).

### tRPC is the entire API layer — two calling paths

The server/client boundary is the key thing to understand here:

- **Define** procedures in `src/server/api/routers/*.ts` using `publicProcedure` / `protectedProcedure` from `src/server/api/trpc.ts`, then **register the router in `src/server/api/root.ts`** (`appRouter`). Routers are not auto-discovered.
- `createTRPCContext` (in `trpc.ts`) injects `{ db, session, headers }` into every procedure. `protectedProcedure` throws `UNAUTHORIZED` unless logged in and narrows `ctx.session.user` to non-null.
- **Call from Server Components** via `~/trpc/server.ts` — exports `api` (a direct server-side caller) and `HydrateClient`. Use `api.x.y.prefetch()` in an RSC, then wrap children in `<HydrateClient>` to hydrate the client cache (see `src/app/page.tsx`).
- **Call from Client Components** via `~/trpc/react.tsx` — exports `api` as TanStack Query hooks (`useQuery` / `useSuspenseQuery` / `useMutation`). Requires `TRPCReactProvider` (mounted in `src/app/layout.tsx`). See `src/app/_components/post.tsx`.
- Both paths share the `AppRouter` type, superjson serialization, and the `RouterInputs` / `RouterOutputs` inference helpers exported from `react.tsx`.
- A timing middleware adds a **random ~100–500ms artificial delay in dev** to surface request waterfalls — expect slower local responses by design.

### Auth

NextAuth v5 with the Prisma adapter (database sessions, not JWT) and the Discord provider. `~/server/auth` exports a React-`cache`d `auth()` used both in RSCs and in the tRPC context. The session is augmented with `user.id` via a callback plus module augmentation in `src/server/auth/config.ts` — extend the session shape there. Route handler: `src/app/api/auth/[...nextauth]/route.ts`.

### Conventions

- Path alias `~/*` → `src/*`.
- TypeScript is strict with `noUncheckedIndexedAccess` and `checkJs`; ESLint runs type-checked rules and enforces inline type imports (`import { type Foo }`).

## Agent skills

### Issue tracker

Issues and PRDs live as GitHub issues, managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` + `docs/adr/` at the repo root (created lazily). See `docs/agents/domain.md`.
