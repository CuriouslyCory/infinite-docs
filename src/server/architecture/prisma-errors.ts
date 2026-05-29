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

const EDGE_DEDUP_INDEX_NAME = "idx_edge_dedup";
const EDGE_DEDUP_COLUMNS = ["canvasNodeId", "sourceId", "targetId"] as const;

// Matches the `idx_edge_dedup` partial unique index (ADR-0010). Narrowed on
// the constraint identifier so an unrelated future P2002 on Edge — e.g. a
// Flow or FlowRoute index added by a later slice — is not silently swallowed
// as "duplicate Connection". Covers both Prisma error shapes:
//   - Legacy query engine: `meta.target` is the constraint name (string) or
//     the column-name array.
//   - `@prisma/adapter-pg` driver path (Prisma 7, what this repo uses today):
//     `meta.driverAdapterError.cause` carries `originalMessage`
//     (`unique constraint "idx_edge_dedup"`) and `constraint.fields` (the
//     quoted column names).
export function isEdgeDedupCollision(error: unknown): boolean {
  if (!isPrismaUniqueViolation(error)) return false;
  const meta = error.meta;
  if (!meta || typeof meta !== "object") return false;

  // Legacy shape.
  const target = (meta as { target?: unknown }).target;
  if (target === EDGE_DEDUP_INDEX_NAME) return true;
  if (Array.isArray(target) && matchesEdgeColumns(target)) return true;

  // Driver-adapter shape.
  const driverCause = (
    meta as { driverAdapterError?: { cause?: unknown } }
  ).driverAdapterError?.cause;
  if (!driverCause || typeof driverCause !== "object") return false;

  const originalMessage = (driverCause as { originalMessage?: unknown })
    .originalMessage;
  if (
    typeof originalMessage === "string" &&
    originalMessage.includes(EDGE_DEDUP_INDEX_NAME)
  ) {
    return true;
  }

  const fields = (
    driverCause as { constraint?: { fields?: unknown } }
  ).constraint?.fields;
  return Array.isArray(fields) && matchesEdgeColumns(fields);
}

// Postgres' driver-adapter quotes the column names (`"canvasNodeId"`); the
// legacy shape passes them bare. Strip quotes before comparing so the same
// helper accepts both.
function matchesEdgeColumns(raw: readonly unknown[]): boolean {
  if (raw.length !== EDGE_DEDUP_COLUMNS.length) return false;
  const normalized = raw.map((f) =>
    typeof f === "string" ? f.replace(/^"|"$/g, "") : f,
  );
  return EDGE_DEDUP_COLUMNS.every((c) => normalized.includes(c));
}
