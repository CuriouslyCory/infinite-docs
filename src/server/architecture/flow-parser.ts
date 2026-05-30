import YAML from "yaml";

import { MAX_FLOW_SPEC_SOURCE_BYTES, type FlowSpecKind } from "~/lib/schemas";

/**
 * Bounded loader for FlowSpec source text. Pure function — no `db`, no
 * `actor` — so it is testable in isolation and callable from anywhere. The
 * "bounded" half is load-bearing: `FlowSpec.source` is UNTRUSTED user-pasted
 * content (prompt-injection standing note, CONTEXT.md, including the
 * parse-time clause), so a hostile spec must not OOM the parser or the
 * server.
 *
 * Returns a discriminated result: `{ flows }` on success (possibly empty),
 * `{ parseError }` on any rejection. NEVER throws to the caller — the
 * service stores `parseError` on the FlowSpec and surfaces a sanitized human
 * message to the user. Raw parser-library messages are not propagated
 * (they leak internals and are not actionable).
 *
 * Slice 1 implements OPENAPI only; the other kinds persist with `parseError`
 * until their parsers land additively in later slices (ADR-0011). Webhooks,
 * callbacks, and external `$ref` are intentionally NOT extracted — the walker
 * iterates the closed set `paths.*.{get,put,post,delete,patch,options,head,trace}`
 * and never resolves a `$ref` (security-load-bearing).
 */

// Hard caps enforced inside the parser. `MAX_FLOW_SPEC_SOURCE_BYTES` is also
// the Zod boundary cap (~/lib/schemas) — belt + suspenders so a future caller
// that bypasses Zod still cannot OOM the parser.
const MAX_DEPTH = 32;
const MAX_OPERATIONS = 500;

const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
] as const;

export interface ParsedFlow {
  kind: "OPENAPI_OPERATION";
  key: string;
  title: string;
  polarity: "INBOUND";
  signature: unknown;
}

export type ParseFlowSpecResult =
  | { flows: ParsedFlow[] }
  | { parseError: string };

export function parseFlowSpec(
  kind: FlowSpecKind,
  source: string,
): ParseFlowSpecResult {
  // `source.length` is UTF-16 code units, not bytes — a CJK or emoji-dense
  // spec can be over the 1 MB byte cap while passing a code-unit check. The
  // constant is named `_BYTES` for a reason; measure bytes.
  if (new TextEncoder().encode(source).length > MAX_FLOW_SPEC_SOURCE_BYTES) {
    return { parseError: "Spec source exceeds the 1 MB cap." };
  }

  if (kind !== "OPENAPI") {
    return {
      parseError: `Parser for ${kind} is not implemented yet — source stored verbatim.`,
    };
  }

  let parsed: unknown;
  try {
    parsed = loadAsYamlOrJson(source);
  } catch {
    // yaml@2's default `maxAliasCount` defends against alias bombs; any
    // throw from parse-time has been sanitized to a human message by then.
    return {
      parseError:
        "Couldn't parse spec as OpenAPI — input is not valid YAML or JSON.",
    };
  }

  if (!isPlainObject(parsed)) {
    return { parseError: "Couldn't parse spec as OpenAPI — top-level is not an object." };
  }

  if (exceedsDepth(parsed, MAX_DEPTH)) {
    return {
      parseError: `Couldn't parse spec as OpenAPI — nesting exceeds the depth cap (${MAX_DEPTH}).`,
    };
  }

  const paths = (parsed as { paths?: unknown }).paths;
  if (!isPlainObject(paths)) {
    return { flows: [] };
  }

  const flows: ParsedFlow[] = [];
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isPlainObject(pathItem)) continue;
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!isPlainObject(op)) continue;

      if (flows.length >= MAX_OPERATIONS) {
        return {
          parseError: `Couldn't parse spec as OpenAPI — operation count exceeds the cap (${MAX_OPERATIONS}).`,
        };
      }

      const summary = typeof op.summary === "string" ? op.summary : undefined;
      const operationId =
        typeof op.operationId === "string" ? op.operationId : undefined;
      const key = `${method.toUpperCase()} ${path}`;
      flows.push({
        kind: "OPENAPI_OPERATION",
        key,
        title: summary ?? operationId ?? key,
        polarity: "INBOUND",
        signature: {
          method: method.toUpperCase(),
          path,
          parameters: op.parameters,
          requestBody: op.requestBody,
          responses: op.responses,
        },
      });
    }
  }

  return { flows };
}

// Auto-detect JSON vs YAML by leading non-whitespace character. JSON's
// strictness short-circuits any YAML ambiguity (a YAML loader can parse
// JSON, but we use the strict JSON path when the input is clearly JSON so
// errors are clearer).
function loadAsYamlOrJson(source: string): unknown {
  const trimmed = source.trimStart();
  const first = trimmed[0];
  if (first === "{" || first === "[") {
    return JSON.parse(trimmed);
  }
  // yaml@2 default config: `maxAliasCount = 100` (alias-bomb guard); no
  // `$ref` resolution (we capture refs verbatim in the signature blob);
  // throws on malformed input.
  return YAML.parse(source);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

// Iterative depth walk (recursion would itself blow the stack on a deep
// hostile input). Walks plain objects and arrays only — primitive leaves and
// non-plain objects terminate.
function exceedsDepth(root: unknown, cap: number): boolean {
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
