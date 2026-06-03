import { type SpecKind as PrismaSpecKind } from "../../../../generated/prisma/client";
import { type SpecKind } from "~/lib/schemas";
import { enforceBounds } from "./bounds";
import { openapiParser } from "./openapi";
import { sqlDdlParser } from "./sql-ddl";
import type { ParseResult, SpecParser } from "./types";

// Compile-time parity guard between the client-safe Zod `specKind` enum and the
// Prisma `SpecKind` enum — same discipline the `nodeKind` guard enforces in
// node.service.ts. If either side drifts, one of these maps stops type-checking
// and `pnpm check` fails. Lives server-side because importing the Prisma enum is
// the leak forbidden in client code (ADR-0004); the client only sees the Zod one.
const _zodSpecKindIsPrisma: Record<SpecKind, PrismaSpecKind> = {
  OPENAPI: "OPENAPI",
  ASYNCAPI: "ASYNCAPI",
  TS_SIGNATURE: "TS_SIGNATURE",
  GRAPHQL: "GRAPHQL",
  SQL_DDL: "SQL_DDL",
  CUSTOM: "CUSTOM",
};
const _prismaSpecKindIsZod: Record<PrismaSpecKind, SpecKind> = {
  OPENAPI: "OPENAPI",
  ASYNCAPI: "ASYNCAPI",
  TS_SIGNATURE: "TS_SIGNATURE",
  GRAPHQL: "GRAPHQL",
  SQL_DDL: "SQL_DDL",
  CUSTOM: "CUSTOM",
};
void _zodSpecKindIsPrisma;
void _prismaSpecKindIsZod;

/**
 * The parser registry (ADR-0025's shape; output re-pointed to Components by
 * ADR-0029). Exhaustive `Record<SpecKind, …>` so adding a SpecKind without a
 * decision here fails the build. `null` = no parser yet — those kinds surface a
 * readable `parseError` rather than silently generating nothing. Only OpenAPI
 * and SQL-DDL ship in this slice; the rest are additive follow-ups.
 */
const PARSERS: Record<SpecKind, SpecParser | null> = {
  OPENAPI: openapiParser,
  SQL_DDL: sqlDdlParser,
  ASYNCAPI: null,
  TS_SIGNATURE: null,
  GRAPHQL: null,
  CUSTOM: null,
};

/** Whether a SpecKind has a parser (drives which kinds the attach UI offers). */
export function isParseable(kind: SpecKind): boolean {
  return PARSERS[kind] !== null;
}

/**
 * Parses a Spec's `source` with the registered parser for its `kind`, then
 * enforces the anti-OOM bounds + `specKey` uniqueness on the result. Total
 * function: never throws on bad input — returns `{ ok: false, parseError }` so
 * the caller records the error and generates nothing (#64 / ADR-0029).
 */
export function parseSpec(kind: SpecKind, source: string): ParseResult {
  const parser = PARSERS[kind];
  if (parser === null) {
    return {
      ok: false,
      parseError: `${kind} specs cannot be parsed into Components yet.`,
    };
  }
  const result = parser.parse(source);
  if (!result.ok) return result;

  const bounded = enforceBounds(result.tree, result.connections);
  if (!bounded.ok) return { ok: false, parseError: bounded.parseError };
  return result;
}

export {
  diffConnections,
  flattenParsed,
  parseSpecDiff,
  type ExistingGeneratedComponent,
  type ExistingGeneratedConnection,
  type FlatParsedComponent,
  type SpecChangedField,
  type SpecConnectionDiff,
  type SpecDiff,
  type SpecDiffChanged,
  type SpecDiffDropped,
} from "./diff";
export type { ParseResult, SpecParser } from "./types";
