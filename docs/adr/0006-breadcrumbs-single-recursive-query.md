# 6. The Canvas breadcrumb trail is one recursive query, never a per-level walk

## Status

Accepted

## Context

This slice generalizes the **Canvas** read to any **scope** and adds the
**breadcrumb trail** to `getCanvas` — the ordered ancestor chain from the
**Project** root down to the current scope's Component (see CONTEXT.md
"Breadcrumbs"). It is the data foundation for **Descent** (opening a Component to
enter its interior Canvas), which renders the trail as navigation later.

A breadcrumb trail walks a Node's `parentId` upward to the root. The obvious
implementation is a loop: fetch the scope Node, read its `parentId`, fetch the
parent, repeat until `parentId IS NULL`. That loop issues **one query per level**
— an N+1 whose latency grows with nesting depth. The whole point of `getCanvas`
is the opposite: it materializes a Canvas in a **single round trip** with no
per-level query walk (ADR-0001), because the perf philosophy is "make the app
feel the fastest" and waterfalls are the enemy. A per-level breadcrumb walk would
quietly reintroduce the very waterfall the read exists to avoid.

PostgreSQL answers ancestry in one statement with a **recursive common table
expression** (`WITH RECURSIVE`). Prisma has no first-class recursive-query API, so
this is the repo's **first raw SQL** (`$queryRaw`). Two facts make that safe
within the established architecture: `$queryRaw` is available on the injected
`Db` (`Prisma.TransactionClient`) — it is not on the interactive-transaction deny
list — so the query runs on the same injected handle every service uses and stays
exercisable against real Postgres (ADR-0003); and the only dynamic values (the
scope id and project id) are **bound parameters**, never interpolated text.

## Decision

**The breadcrumb trail is computed in a single recursive CTE, folded into
`getCanvas`'s existing concurrent fetch.** `getCanvas` already runs its interior
**Nodes** and interior **Edges** reads concurrently (`Promise.all`); the
breadcrumb query joins that array as a third concurrent read, so the trail costs
no extra round-trip depth — concurrency, not a waterfall. The result shape is
`{ interiorNodes, interiorEdges, breadcrumbs }`, with `breadcrumbs: { id, title }[]`
ordered **root → current**, the current scope included as the last element.

Specifics that are part of the decision, not incidental:

- **The root scope (`canvasNodeId === null`) short-circuits to `[]`** with no
  query — it has no ancestors, and a `null` anchor would match nothing anyway.
- **A non-null scope that returns an empty trail is a not-found.** The trail is
  the **existence check**: a live scope always returns at least its own row
  (depth 0), so an empty trail means the `canvasNodeId` resolved to no live Node
  in this Project (missing, soft-deleted, or cross-project). `getCanvas` throws
  `NotFoundError` in that case. The check keys off the **breadcrumb-row count,
  never the interior-node count** — an empty interior is a legitimate leaf
  Canvas and must stay distinguishable from a nonexistent scope.
- **Both the anchor and the recursive step filter `deletedAt IS NULL`** and are
  scoped to `projectId`, so soft-deleted and cross-project Nodes never enter a
  trail.
- **A depth cap (`depth < 256`) terminates the recursion.** The graph is a tree
  today (no `move`/reparent), so a cycle cannot occur; the cap is defense for a
  future reparent feature, **not** a nesting limit.
- **Raw-SQL discipline:** every model/column identifier is **double-quoted
  PascalCase** (`"Node"`, `"parentId"`, `"projectId"`, `"deletedAt"`) because
  Postgres folds unquoted identifiers to lowercase and fails at runtime; the
  scope id and project id are **bound parameters** and user-authored content is
  never interpolated (prompt-injection standing note, CONTEXT.md).

## Consequences

- **"Breadcrumbs are one recursive query, never a per-level walk" is now a
  reviewable invariant.** A future change that replaces the CTE with an iterative
  parent-by-parent walk is a regression against this ADR, not a simplification —
  the same way ADR-0005 makes "Edge scope is explicit, not inferred" a reviewable
  rule. This is why the decision earns its own record.
- **Reading `Node.parentId` ancestry does NOT violate ADR-0005.** ADR-0005
  forbids _inferring an Edge's Canvas from its endpoints_; breadcrumbs _read the
  stored `Node.parentId` tree_, which is the authoritative, recorded source of
  truth for nesting. Traversing a column that exists to be traversed is not the
  same as substituting endpoint geometry for a missing stored scope. A reviewer
  must not pattern-match "parentId walk" onto the forbidden edge-scope inference.
- **`pnpm check` cannot see into raw SQL.** A wrong identifier or casing slips
  past ESLint and `tsc` and fails only at runtime, so this slice's correctness
  rests on the service tests running against **real Postgres** (ADR-0003), not on
  the static gate. Running `pnpm test` is therefore part of the Definition of
  Done, not optional.
- **`$queryRaw` rows are untyped.** The query result is typed by hand
  (`$queryRaw<{ id: string; title: string }[]>`); a column-name typo yields
  `undefined` silently, which is another reason the behavior is asserted by test.
- **This is the repo's only raw SQL.** Keeping it the single exception — rather
  than letting raw queries spread — preserves the Prisma-typed surface everywhere
  else. A second recursive read (e.g. a subtree delete) should reuse this pattern
  and cite this ADR.
- **The trail is now rendered by the Descent breadcrumb bar (ADR-0007)**, which
  reads it from the same hydrated `getCanvas` cache as the Canvas island. The
  root scope stays `[]`; the Project is supplied as a presentational root crumb,
  never injected into this array.
