---
name: add-component-kind
description: Adds a new Component kind (`NodeKind` enum value) end-to-end — Prisma + Zod + parity guard + client catalog + server label + migration + docs + validation — in lockstep so the exhaustive `Record<NodeKind, …>` types catch any missing edit at compile time. Use when the user wants to "add a new component kind/type", "extend the NodeKind enum", "add X as a component kind", or names a specific new kind (`LAMBDA`, `BUCKET`, `WORKER`, etc.) to admit.
---

# Add a Component kind

Component kinds are the cosmetic categories on a `Node` (icon + color + kind-affinity ranking). The taxonomy is closed and exhaustive (CONTEXT.md "Component kind"; [ADR-0018](../../../docs/adr/0018-nodekind-expanded-taxonomy-stays-cosmetic.md)) — every kind appears in **eight** lockstep places, kept honest by `Record<NodeKind, …>` types and a service-layer parity guard. Miss one and `pnpm check` fails; miss the migration and the test suite fails.

This skill walks an agent through every touch-point in one ordered pass, with the compiler as the safety net.

## Inputs (gather these before editing anything)

Ask the user for any that are missing. Don't guess.

1. **Enum value** — `SCREAMING_SNAKE_CASE`, no spaces, e.g. `LAMBDA`, `STATIC_SITE`, `OBJECT_STORE`. This is the immutable code identifier.
2. **User-facing label** — Title Case prose, e.g. `Lambda`, `Static site`, `Object store`. Multi-word labels are spelled out (see `KIND_LABEL` for the existing voice). This is what the palette displays and what `cmdk` searches.
3. **Lucide icon name** — must exist in `lucide-react`. Verify before assigning:
   ```bash
   node -e 'const i=require("lucide-react"); for (const n of ["Lambda","Zap","Globe"]) process.stdout.write(n+":"+(i[n]?"Y":"-")+" ");console.log()'
   ```
   Pick a glyph that is visually distinct. Duplicates are tolerated (`STORED_PROCEDURE` and `SERVICE` both use `Cog` today by design), but flag it to the user — don't silently reuse `Box`.
4. **Affinity — outbound** (what this kind suggests as **children** in its own Canvas). Often `[]` for terminal-ish kinds (`TABLE`, `ENDPOINT`, `VARIABLE`). Ask the user.
5. **Affinity — inbound** (which **existing** parent kinds should rank this new kind near the top of their palette). Often one or two parents, sometimes the `ROOT` sentinel. **The agent must enumerate the candidate parents and ask.** Skipping this step is the most common way a new kind ships and then "doesn't show up" — it only shows up when the user descends into a parent whose affinity row mentions it. (It always shows up under "All kinds" regardless; this is just ranking.)
6. **Position in `KIND_ORDER`** — the array's order drives the alphabetic `KIND_ORDER` baseline before affinity sorting. Group with the new kind's tier (see the tier comments in `prisma/schema.prisma`).
7. **Update ADR-0018?** — the ADR lists the realized 26 kinds. Per its own *"further kinds are an additive change"* clause, a small new kind doesn't strictly require an ADR amendment. Ask the user: do they want one-line additions to ADR-0018's *"20 new kinds"* table, or a fresh ADR-N (only when the kind carries a non-trivial design decision)?

## The eight lockstep edits, in order

Do these in this order so the compiler catches drift mid-flight rather than at the end. Use **`SCREAMING_SNAKE_CASE`** consistently for the value; use the **literal label** consistently for prose.

### 1. `prisma/schema.prisma` — the Prisma enum

```prisma
enum NodeKind {
    GENERIC
    // ...existing kinds, grouped by tier under comments...
    // Add the new kind under the right tier comment, e.g.:
    // Runtime
    CONTAINER
    SERVICE
    MICROSERVICE
    CRON
    LAMBDA   // ← new
    QUEUE
    // ...
}
```

### 2. `src/lib/schemas.ts` — the Zod enum

```ts
export const nodeKind = z.enum([
  "GENERIC",
  // ...existing values in their order...
  "LAMBDA",   // ← new (keep in the same tier-position as in schema.prisma for readability)
  // ...
]);
```

### 3. `src/server/architecture/node.service.ts` — the parity guard (both directions)

There are **two** `Record` objects near the top of the file. Both must gain the new kind. The Zod-side type checker enforces the first; the Prisma-side enforces the second.

```ts
const _zodKindIsPrismaKind: Record<NodeKind, PrismaNodeKind> = {
  // ...existing entries...
  LAMBDA: "LAMBDA",   // ← new
};
const _prismaKindIsZodKind: Record<PrismaNodeKind, NodeKind> = {
  // ...existing entries...
  LAMBDA: "LAMBDA",   // ← new
};
```

If either side is missing, `pnpm check` fails with a non-exhaustive `Record` error pointing at the file.

### 4. `src/lib/node-kinds.ts` — the client catalog (FOUR things)

a. Import the lucide icon at the top:

```ts
import {
  // ...
  Zap,   // ← new, the chosen lucide glyph
  // ...
} from "lucide-react";
```

b. `KIND_LABEL` row:

```ts
export const KIND_LABEL: Record<NodeKind, string> = {
  // ...
  LAMBDA: "Lambda",   // ← new — exact user-facing label
};
```

c. `KIND_ICON` row:

```ts
export const KIND_ICON: Record<NodeKind, LucideIcon> = {
  // ...
  LAMBDA: Zap,   // ← new
};
```

d. `KIND_ORDER` array entry (positional — group with the kind's tier):

```ts
export const KIND_ORDER: readonly NodeKind[] = [
  "GENERIC",
  // ...
  "LAMBDA",   // ← new
  // ...
];
```

e. `KIND_AFFINITY` — the new kind's **own** row (its preferred children):

```ts
export const KIND_AFFINITY: Record<NodeKind | typeof ROOT_AFFINITY_KEY, readonly NodeKind[]> = {
  // ...
  LAMBDA: ["FUNCTION", "MODULE"],   // ← new — what to suggest INSIDE a LAMBDA
};
```

f. `KIND_AFFINITY` — every **inbound** parent that should rank this new kind near the top. From the answer to Input #5:

```ts
HOST: ["CONTAINER", "SERVICE", "MICROSERVICE", "CRON", "LAMBDA"],   // ← amended
APPLICATION: ["MODULE", "SERVICE", "FUNCTION", "CLASS", "LAMBDA"],   // ← amended
```

### 5. `src/server/architecture/markdown.ts` — the server serializer label

This is a **separate** label map keyed by `PrismaNodeKind`, deliberately kept free of `lucide-react` so the serializer stays pure (ADR-0017). It also has an exhaustive `Record<PrismaNodeKind, string>`, so the compiler forces it.

```ts
const KIND_LABEL: Record<PrismaNodeKind, string> = {
  // ...
  LAMBDA: "Lambda",   // ← new — SAME label as the client catalog
};
```

The two `KIND_LABEL` maps must agree on the user-facing label. There's no runtime check for this — both are typed `Record<…, string>`, so a typo (`"Lambdba"`) compiles. Eyeball the label match before moving on.

### 6. Author + apply the database migration

```bash
pnpm db:author add_<kind_name>_to_node_kind   # snake_case description
```

Inspect the generated SQL — it must be one or more `ALTER TYPE "NodeKind" ADD VALUE '<NAME>';` lines, with NO other changes. If the file contains anything else, the dev DB drifted; investigate before applying. Then:

```bash
pnpm db:migrate   # applies migration + regenerates the Prisma client
pnpm db:check     # confirm no schema drift remains (exit 0)
```

### 7. Validation gates

```bash
pnpm check    # eslint + tsc; the exhaustive Records fail compile if any edit was missed
pnpm test     # vitest; the existing round-trip test iterates nodeKind.options and asserts persist+read
```

The round-trip test in `src/server/architecture/__tests__/node.service.test.ts` ("persists and reads back every kind in the expanded taxonomy") implicitly covers the new kind by reading `nodeKind.options` — if Step 6 was skipped, this is the test that throws (`invalid input value for enum "NodeKind"`).

### 8. Verify in the running app (do not skip)

Per the **dev-browser-automation** memory: *always check the running app before claiming a UI path can't be tested*. The persistent daemon browser is logged in.

```bash
# Make sure no stale dev server is on :3000 (a leftover from a prior session
# serves a pre-change client bundle and produces confusing optimistic-rollback toasts):
pkill -f "next-server" 2>/dev/null; pkill -f "next dev" 2>/dev/null
pnpm dev &
```

Then via `dev-browser`: open an existing project (or create one), click **Add Component**, search for the new kind by label, and confirm:

- It appears under "All kinds" alphabetized.
- If you added inbound affinity, descending into a parent of that kind ranks the new kind in the "Suggested" group.
- Selecting it actually creates the Component (HTTP 200 + node renders, no rollback toast).
- Single-click → detail panel **Kind** row → reopens the palette with the new kind marked.

A failing optimistic add ("Couldn't add the component. Please try again.") on otherwise-passing tests almost always means a stale dev server — kill it and rerun `pnpm dev`.

## Documentation (optional but recommended in the same slice)

The "docs travel with code slices" memory: don't defer these.

- **CONTEXT.md** — the *Component kind* entry inlines the value list. Add the new kind in its tier position. Skip ADR drift; the parenthetical *"further kinds remain an additive change"* covers it.
- **ADR-0018** — only amend if the user asked for it (Input #7). The ADR's *"20 new kinds"* table is a snapshot of the slice that landed it, not a live registry; a single additive kind doesn't usually warrant rewriting that section. A fresh ADR is appropriate only when the new kind carries a real decision (a new tier, a new affinity philosophy, a per-kind color exception).
- **A new ADR** is **not** typically needed for an additive kind. Resist the urge.

## Common pitfalls (collected from the lived experience)

- **Stale dev server.** Multiple `next-server` processes on `:3000` can persist across sessions. The newest schema is read by the running server, but the **client bundle** that the browser is talking to is from the older server. Symptom: server returns HTTP 200 on `createNode`, but the UI toasts *"Couldn't add the component"* and rolls back. Fix: `pkill -f next-server` then `pnpm dev` clean.
- **Lucide icon doesn't exist.** `lucide-react` is large but not infinite. Verify with the one-liner above. If the obvious glyph is missing, search the lucide site (https://lucide.dev/icons) and pick the closest existing one; do **not** invent.
- **Forgetting one of the two parity arrays.** The Zod-side guard catches "Zod has X, Prisma doesn't"; the Prisma-side catches "Prisma has X, Zod doesn't." You need both. The compile error names the file and the missing key.
- **Editing only the client `KIND_LABEL`, not the serializer's.** Both maps must list every Prisma enum value. The server-side one in `markdown.ts` is deliberately separate (ADR-0017). The compiler catches a missing key in either, but it can't catch divergent label text — eyeball it.
- **Skipping the migration.** Adding the Zod value without a Prisma migration compiles fine. The failure is at runtime when Postgres rejects the new enum value in an `INSERT`. The expanded-enum round-trip test in vitest catches this; do not skip `pnpm test`.
- **Setting affinity only on the new kind's row.** A new kind's *own* row tells the palette what to suggest *inside* it. **Inbound** affinity (parent kinds that should rank this new kind first) is a separate decision — and is the one users actually notice, since the new kind always appears under "All kinds" but won't surface in "Suggested" without an inbound mention.
- **"Just disable the exhaustive `Record` type to make it compile."** Forbidden by [CLAUDE.md philosophy #6](../../../CLAUDE.md). The exhaustive `Record<NodeKind, …>` IS the spec; bypassing it ships an unlabeled kind in production.
- **Affinity is *not* a constraint** (ADR-0019). Don't add a service-level check that rejects "the new kind under the wrong parent." Anything goes; affinity only ranks.
- **The `<select>` is gone** (ADR-0020). If the new kind needs to be selectable in some other surface the user mentions, route it through `KindPickerPopover` from `src/app/p/[slug]/_canvas/kind-palette.tsx`; don't reintroduce a select.

## Done checklist

Walk this before declaring the kind shipped.

- [ ] `prisma/schema.prisma` has the value
- [ ] `src/lib/schemas.ts` Zod `nodeKind` has the value (same name)
- [ ] `src/server/architecture/node.service.ts` has the value in **both** parity records
- [ ] `src/lib/node-kinds.ts` has: import, `KIND_LABEL`, `KIND_ICON`, `KIND_ORDER`, `KIND_AFFINITY[new]`, plus any inbound `KIND_AFFINITY[parent]` amendments
- [ ] `src/server/architecture/markdown.ts` `KIND_LABEL` has the value (matching label)
- [ ] Migration file exists under `prisma/migrations/<ts>_<name>/migration.sql` with only `ALTER TYPE … ADD VALUE …`
- [ ] `pnpm db:migrate` succeeded; `pnpm db:check` is clean
- [ ] `pnpm check` passes
- [ ] `pnpm test` passes (round-trip test exercises every kind)
- [ ] Dev browser: the kind appears in the palette, is creatable, the detail-panel Kind row opens with it
- [ ] CONTEXT.md *Component kind* value list mentions the new kind
- [ ] Optional: ADR-0018 amended only if the user asked
- [ ] Commit message follows the repo style (sentence-case imperative; no scope prefix). Stage files by name, never `git add -A`.
