import YAML from "yaml";

import {
  MAX_FLOW_SPEC_SOURCE_BYTES,
  type FlowInteraction,
  type FlowKind,
} from "~/lib/schemas";

/**
 * Shared primitives for the FlowSpec parser registry (flow-parser/index.ts).
 * Every parser is a pure function over UNTRUSTED `FlowSpec.source` (the
 * prompt-injection standing note, CONTEXT.md, including its parse-time clause),
 * so the bounded-loader half is security-load-bearing: a hostile spec must not
 * OOM the parser or the server. These helpers — the byte cap, the iterative
 * depth walk, the YAML/JSON loader with no `$ref` resolution — are how each
 * parser stays bounded. Kept in one module so the discipline is identical
 * across kinds, not re-derived per parser.
 */

/**
 * One materialized Flow, pre-persistence. `flow.service.ts` writes `kind`,
 * `key`, `title`, `interaction`, and `signature` verbatim, so the type widened
 * from the OpenAPI-only literal (`"OPENAPI_OPERATION"` / `"REQUEST"`) to the
 * full enums once the registry gained more kinds. `signature` is UNTRUSTED
 * structured content — stored as JSON, never interpolated.
 */
export interface ParsedFlow {
  kind: FlowKind;
  key: string;
  title: string;
  interaction: FlowInteraction;
  signature: unknown;
}

/**
 * Discriminated parser result. NEVER thrown to the caller: a parser that hits
 * malformed input, a library throw, or a cap returns `{ parseError }` with a
 * sanitized human message (raw parser-library messages leak internals and are
 * not actionable). `flow.service.ts` stores the message on the FlowSpec and
 * surfaces it as a non-blocking toast.
 */
export type ParseFlowSpecResult =
  | { flows: ParsedFlow[] }
  | { parseError: string };

/** A bounded, pure loader for one FlowSpec source format. */
export type SpecParser = (source: string) => ParseFlowSpecResult;

// The object-nesting cap shared by the structured (YAML/JSON) parsers. A deep
// hostile document is rejected before the walker descends it.
export const MAX_DEPTH = 32;

/**
 * UTF-8 byte-cap gate, shared by `parseFlowSpec` before dispatch and available
 * to any parser that wants to re-check. `source.length` counts UTF-16 code
 * units, not bytes — a CJK or emoji-dense spec can exceed the 1 MB byte cap
 * while passing a code-unit check, so we measure encoded bytes.
 */
export function exceedsByteCap(source: string): boolean {
  return new TextEncoder().encode(source).length > MAX_FLOW_SPEC_SOURCE_BYTES;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * Auto-detect JSON vs YAML by leading non-whitespace character. JSON's
 * strictness short-circuits any YAML ambiguity (a YAML loader can parse JSON,
 * but the strict JSON path gives clearer errors when the input is clearly
 * JSON). `yaml@2`'s default `maxAliasCount = 100` is the alias-bomb guard; no
 * `$ref`/anchor resolution beyond that — refs are captured verbatim in the
 * signature blob, never followed. Throws on malformed input (callers catch).
 */
export function loadAsYamlOrJson(source: string): unknown {
  const trimmed = source.trimStart();
  const first = trimmed[0];
  if (first === "{" || first === "[") {
    return JSON.parse(trimmed);
  }
  return YAML.parse(source);
}

/**
 * Iterative depth walk (recursion would itself blow the stack on a deep
 * hostile input). Walks plain objects and arrays only — primitive leaves and
 * non-plain objects terminate.
 */
export function exceedsDepth(root: unknown, cap: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 0 },
  ];
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (depth > cap) return true;
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: depth + 1 });
    } else if (isPlainObject(value)) {
      for (const child of Object.values(value)) {
        stack.push({ value: child, depth: depth + 1 });
      }
    }
  }
  return false;
}
