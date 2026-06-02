import type { ParsedComponent } from "~/lib/schemas";

/**
 * The outcome of parsing a Spec's `source`. A parser NEVER throws on malformed
 * input or on exceeding a safety bound — it returns `{ ok: false, parseError }`
 * so the caller can record the error on the Spec row and generate nothing
 * (never a partial tree; #64 / ADR-0029). `ok: true` carries the recursive
 * Component tree (top-level nodes attach under the Spec's owner Component).
 */
export type ParseResult =
  | { ok: true; tree: ParsedComponent[] }
  | { ok: false; parseError: string };

/**
 * A bounded, pure parser for one Spec format (ADR-0025's registry shape, with
 * the output re-pointed from Flows to Components by ADR-0029). Pure: no I/O, no
 * `$ref` resolution, no clock — same input always yields the same tree, which
 * is what makes the diff's stable `specKey` matching deterministic.
 */
export interface SpecParser {
  parse(source: string): ParseResult;
}
