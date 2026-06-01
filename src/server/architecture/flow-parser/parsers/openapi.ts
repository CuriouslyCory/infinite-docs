import {
  MAX_DEPTH,
  exceedsDepth,
  isPlainObject,
  loadAsYamlOrJson,
  type ParsedFlow,
  type ParseFlowSpecResult,
} from "../shared";

/**
 * OpenAPI loader. Iterates the closed set
 * `paths.*.{get,put,post,delete,patch,options,head,trace}` and never resolves a
 * `$ref` (security-load-bearing). Webhooks, callbacks, and external refs are
 * intentionally NOT extracted — they capture verbatim into the signature blob
 * but are not walked. Each operation becomes one REQUEST Flow (the caller
 * depends on it, so the arrow points at the owner; ADR-0023).
 */

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

export function parseOpenApi(source: string): ParseFlowSpecResult {
  let parsed: unknown;
  try {
    parsed = loadAsYamlOrJson(source);
  } catch {
    return {
      parseError:
        "Couldn't parse spec as OpenAPI — input is not valid YAML or JSON.",
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      parseError: "Couldn't parse spec as OpenAPI — top-level is not an object.",
    };
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
        interaction: "REQUEST",
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
