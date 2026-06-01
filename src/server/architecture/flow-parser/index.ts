import { type FlowSpecKind } from "~/lib/schemas";

import { parseAsyncApi } from "./parsers/asyncapi";
import { parseGraphql } from "./parsers/graphql";
import { parseOpenApi } from "./parsers/openapi";
import { parseSqlDdl } from "./parsers/sql-ddl";
import { parseTsSignature } from "./parsers/ts-signature";
import {
  exceedsByteCap,
  type ParsedFlow,
  type ParseFlowSpecResult,
  type SpecParser,
} from "./shared";

export type { ParsedFlow, ParseFlowSpecResult, SpecParser };

/**
 * The FlowSpec parser registry. Each `FlowSpecKind` maps to a bounded, pure
 * parser (flow-parser/parsers/*) or `null` for kinds with no parser — today
 * only `CUSTOM`, which is hand-authored prose persisted verbatim. The exhaustive
 * `Record<FlowSpecKind, …>` is the compile guard: adding a spec kind to the Zod
 * enum (~/lib/schemas) fails the build here until it has a registry entry, the
 * same exhaustiveness discipline the parity guards (flow.service.ts) and the
 * kind catalogs (~/lib/node-kinds, ~/lib/spec-kinds) use. Adding a kind that
 * routes through the diagram is therefore a localized, type-checked change — a
 * parser module plus this one line (ADR-0011).
 */
const REGISTRY: Record<FlowSpecKind, SpecParser | null> = {
  OPENAPI: parseOpenApi,
  ASYNCAPI: parseAsyncApi,
  GRAPHQL: parseGraphql,
  SQL_DDL: parseSqlDdl,
  TS_SIGNATURE: parseTsSignature,
  CUSTOM: null,
};

/**
 * Bounded loader for FlowSpec source text. Pure — no `db`, no `actor` — so it is
 * testable in isolation and callable from anywhere. NEVER throws to the caller:
 * any rejection (oversized source, malformed input, a library throw, a count
 * cap) returns `{ parseError }` with a sanitized message; the service stores it
 * on the FlowSpec and surfaces it as a non-blocking toast. The byte cap is
 * checked here before dispatch (belt + suspenders with the Zod boundary cap) so
 * a future caller that bypasses Zod still cannot hand a parser an oversized
 * blob.
 */
export function parseFlowSpec(
  kind: FlowSpecKind,
  source: string,
): ParseFlowSpecResult {
  if (exceedsByteCap(source)) {
    return { parseError: "Spec source exceeds the 1 MB cap." };
  }

  const parser = REGISTRY[kind];
  if (!parser) {
    return {
      parseError: `${kind} specs have no parser — source stored verbatim.`,
    };
  }

  return parser(source);
}
