import YAML from "yaml";
import type { ComponentMetadata, ParsedComponent } from "~/lib/schemas";
import type { ParseResult, SpecParser } from "./types";

// The HTTP methods OpenAPI defines on a Path Item Object. Anything else on the
// object (parameters, summary, $ref, servers) is not an operation.
const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Shallow OpenAPI parser (#64 / ADR-0029): paths → Endpoint Components, each
 * with its parameters as child Components and its request body summarized into
 * `metadata` (kept shallow rather than exploded into deeper children — depth is
 * additive later with no model change).
 *
 * `specKey` anchors on the most stable per-format id: an operation's
 * `operationId` when present, else `METHOD path` (ADR-0029). Child parameter
 * keys are qualified by their endpoint's key so they stay unique across the
 * whole tree.
 *
 * Accepts both JSON and YAML (YAML is a JSON superset — `YAML.parse` handles
 * either; its `maxAliasCount` default guards against alias-bomb expansion, on
 * top of the source byte cap). No `$ref` resolution: refs are left as opaque
 * metadata, never fetched or expanded (a hostile `$ref` must never become a
 * request — the parse-time-trust standing note, CONTEXT.md).
 */
function parse(source: string): ParseResult {
  let doc: unknown;
  try {
    doc = YAML.parse(source);
  } catch {
    return {
      ok: false,
      parseError: "Could not parse the document as JSON or YAML.",
    };
  }

  if (!isRecord(doc)) {
    return { ok: false, parseError: "OpenAPI document is not a JSON object." };
  }
  const paths = doc.paths;
  if (!isRecord(paths)) {
    return {
      ok: false,
      parseError: "OpenAPI document has no `paths` object.",
    };
  }

  const endpoints: ParsedComponent[] = [];

  for (const [pathStr, pathItemRaw] of Object.entries(paths)) {
    if (!isRecord(pathItemRaw)) continue;
    const pathLevelParams: unknown[] = Array.isArray(pathItemRaw.parameters)
      ? pathItemRaw.parameters
      : [];

    for (const method of HTTP_METHODS) {
      const opRaw = pathItemRaw[method];
      if (!isRecord(opRaw)) continue;

      const methodUpper = method.toUpperCase();
      const specKey =
        asString(opRaw.operationId) ?? `${methodUpper} ${pathStr}`;
      const title =
        asString(opRaw.summary) ?? asString(opRaw.operationId) ?? specKey;

      const metadata: ComponentMetadata = { method: methodUpper, path: pathStr };
      if (Array.isArray(opRaw.tags)) {
        const tags = opRaw.tags.filter(
          (t): t is string => typeof t === "string",
        );
        if (tags.length > 0) metadata.tags = tags;
      }
      const requestBody = summarizeRequestBody(opRaw.requestBody);
      if (requestBody !== undefined) metadata.requestBody = requestBody;

      const opLevelParams: unknown[] = Array.isArray(opRaw.parameters)
        ? opRaw.parameters
        : [];
      // Operation-level parameters override path-level ones with the same
      // (name, in) (OpenAPI spec). `parseParameters` keeps the first occurrence
      // of a duplicate key, so op-level must come first to win.
      const children = parseParameters(specKey, [
        ...opLevelParams,
        ...pathLevelParams,
      ]);

      const endpoint: ParsedComponent = {
        specKey,
        kind: "ENDPOINT",
        title,
        metadata,
      };
      const documentation = asString(opRaw.description);
      if (documentation !== undefined) endpoint.documentation = documentation;
      if (children.length > 0) endpoint.children = children;
      endpoints.push(endpoint);
    }
  }

  return { ok: true, tree: endpoints };
}

// Parameters become child Components. There is no dedicated parameter NodeKind,
// so they are GENERIC (the parser-can't-infer fallback; ADR-0029); the in/type/
// required facts live in `metadata`. Duplicate (name,in) pairs collapse to the
// first — the bounds check would otherwise reject the duplicate key.
function parseParameters(
  endpointKey: string,
  params: unknown[],
): ParsedComponent[] {
  const out: ParsedComponent[] = [];
  const seen = new Set<string>();
  for (const param of params) {
    if (!isRecord(param)) continue;
    const name = asString(param.name);
    const location = asString(param.in);
    if (name === undefined || location === undefined) continue;
    const dedupeKey = `${location}:${name}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const metadata: ComponentMetadata = {
      in: location,
      required: param.required === true,
    };
    if (isRecord(param.schema)) {
      const type = asString(param.schema.type);
      if (type !== undefined) metadata.type = type;
    }
    const child: ParsedComponent = {
      specKey: `${endpointKey}#${dedupeKey}`,
      kind: "GENERIC",
      title: `${name} (${location})`,
      metadata,
    };
    const documentation = asString(param.description);
    if (documentation !== undefined) child.documentation = documentation;
    out.push(child);
  }
  return out;
}

// A shallow, bounded summary of a request body — content types and the
// top-level property names of each media type's schema. Deliberately does NOT
// walk nested schemas or resolve `$ref` (depth is additive later; refs are never
// fetched). Returns undefined when there is nothing useful to record.
function summarizeRequestBody(
  requestBody: unknown,
): ComponentMetadata | undefined {
  if (!isRecord(requestBody)) return undefined;
  const content = requestBody.content;
  if (!isRecord(content)) return undefined;

  const contentTypes = Object.keys(content);
  if (contentTypes.length === 0) return undefined;

  const summary: ComponentMetadata = { contentTypes };
  // Union the top-level property names across every media type's schema (the
  // same body is often offered as JSON + form, occasionally with differing
  // shapes), deduplicated and order-stable.
  const properties = new Set<string>();
  for (const type of contentTypes) {
    const media = content[type];
    if (!isRecord(media) || !isRecord(media.schema)) continue;
    const props = media.schema.properties;
    if (isRecord(props)) {
      for (const name of Object.keys(props)) properties.add(name);
    }
  }
  if (properties.size > 0) summary.properties = [...properties];
  if (requestBody.required === true) summary.required = true;
  return summary;
}

export const openapiParser: SpecParser = { parse };
