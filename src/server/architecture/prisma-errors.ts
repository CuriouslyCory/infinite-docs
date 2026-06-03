import { Prisma } from "../../../generated/prisma/client";

/**
 * Type-guard for a Postgres unique-constraint violation surfaced by Prisma
 * (error code `P2002`). Domain wrappers below add constraint-name narrowing
 * where the service writes more than one unique column and a blanket P2002
 * catch would swallow the wrong condition. The Prisma error class is the
 * same shape whether thrown directly or from inside `db.$transaction(...)`
 * (ADR-0010).
 */
export function isPrismaUniqueViolation(
  error: unknown,
): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

// `slug` is the only unique column written by `createProject`, so any P2002
// on that path is always a slug collision (astronomically unlikely at 128
// bits; the retry just makes the impossible-but-possible case transparent).
// Narrowing is unnecessary here for the same reason it was unnecessary in
// the inline version this helper replaces (see project.service.ts history).
export function isSlugCollision(error: unknown): boolean {
  return isPrismaUniqueViolation(error);
}

// The two partial unique indexes that enforce Connection de-dupe (ADR-0010,
// re-keyed for the typed cross-scope model — ADR-0027/0028): `idx_edge_dedup`
// (directional) and `idx_edge_assoc_dedup` (association).
const EDGE_DEDUP_INDEX_NAMES = [
  "idx_edge_dedup",
  "idx_edge_assoc_dedup",
] as const;

// Matches either Edge de-dupe partial unique index. Narrowed on the constraint
// identifier so an unrelated future P2002 on Edge is not silently swallowed as
// "duplicate Connection". Both indexes are EXPRESSION indexes (the association
// one over LEAST/GREATEST), so the driver reports no usable column array — we
// match on the index NAME only, carried on both Prisma error shapes:
//   - Legacy query engine: `meta.target` is the constraint name.
//   - `@prisma/adapter-pg` driver path (Prisma 7, what this repo uses today):
//     `meta.driverAdapterError.cause.originalMessage` carries
//     `unique constraint "idx_edge_dedup"` (or the association index name).
export function isEdgeDedupCollision(error: unknown): boolean {
  if (!isPrismaUniqueViolation(error)) return false;
  const meta = error.meta;
  if (!meta || typeof meta !== "object") return false;

  // Legacy shape.
  const target = (meta as { target?: unknown }).target;
  if (
    typeof target === "string" &&
    EDGE_DEDUP_INDEX_NAMES.some((name) => target === name)
  ) {
    return true;
  }

  // Driver-adapter shape.
  const driverCause = (meta as { driverAdapterError?: { cause?: unknown } })
    .driverAdapterError?.cause;
  if (!driverCause || typeof driverCause !== "object") return false;

  const originalMessage = (driverCause as { originalMessage?: unknown })
    .originalMessage;
  return (
    typeof originalMessage === "string" &&
    EDGE_DEDUP_INDEX_NAMES.some((name) => originalMessage.includes(name))
  );
}

// The partial unique index enforcing live-only unique Trace names per Project
// (#59 / ADR-0035). Narrowed on the constraint name so an unrelated future P2002
// on Trace is not swallowed as a name collision; carried on both Prisma error
// shapes (legacy `meta.target` and the `@prisma/adapter-pg` driver path's
// `meta.driverAdapterError.cause.originalMessage`), mirroring isEdgeDedupCollision.
const TRACE_NAME_INDEX_NAME = "idx_trace_name_per_project_live";

export function isTraceNameCollision(error: unknown): boolean {
  if (!isPrismaUniqueViolation(error)) return false;
  const meta = error.meta;
  if (!meta || typeof meta !== "object") return false;

  const target = (meta as { target?: unknown }).target;
  if (typeof target === "string" && target === TRACE_NAME_INDEX_NAME) {
    return true;
  }

  const driverCause = (meta as { driverAdapterError?: { cause?: unknown } })
    .driverAdapterError?.cause;
  if (!driverCause || typeof driverCause !== "object") return false;

  const originalMessage = (driverCause as { originalMessage?: unknown })
    .originalMessage;
  return (
    typeof originalMessage === "string" &&
    originalMessage.includes(TRACE_NAME_INDEX_NAME)
  );
}
