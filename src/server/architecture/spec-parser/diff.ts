import type {
  ComponentMetadata,
  NodeKind,
  ParsedComponent,
} from "~/lib/schemas";

/**
 * A parsed node flattened out of the recursive tree, carrying its parent's
 * `specKey` (null = a top-level node, whose parent is the Spec's owner
 * Component). Pre-order: a parent always precedes its children, so the applier
 * can create them in array order and every parent id is already resolved.
 */
export interface FlatParsedComponent {
  specKey: string;
  parentSpecKey: string | null;
  kind: NodeKind;
  title: string;
  documentation?: string;
  metadata?: ComponentMetadata;
}

/**
 * The existing generated children of a Spec, as the diff needs to see them —
 * the live Nodes whose `sourceSpecId` points at this Spec. `metadata` is the
 * raw `Json` column (null when unset).
 */
export interface ExistingGeneratedComponent {
  id: string;
  specKey: string;
  title: string;
  kind: NodeKind;
  metadata: unknown;
}

/** The DERIVED fields a re-parse can change (documentation is user-owned and
 *  never compared; ADR-0029). Surfaced so the conflict modal can show WHAT
 *  changed even when the title is identical (#64). */
export type SpecChangedField = "title" | "kind" | "metadata";

export interface SpecDiffChanged {
  specKey: string;
  nodeId: string;
  parsed: FlatParsedComponent;
  existing: ExistingGeneratedComponent;
  changedFields: SpecChangedField[];
}

export interface SpecDiffDropped {
  nodeId: string;
  specKey: string;
  title: string;
}

/**
 * The classification a re-parse produces against what's already in the graph
 * (#64 / ADR-0029):
 *  - `new` — parsed keys with no matching live Component (created on apply).
 *  - `changed` — matched keys whose DERIVED fields (title/kind/metadata) differ;
 *    documentation is NOT compared (it's user-owned after first create).
 *  - `dropped` — live generated Components whose key is gone from the parse.
 *  - `matchedKeyToId` — every matched key (changed AND unchanged) → its Node id,
 *    so the applier can resolve a new node's parent that is an existing one.
 * Pure: no DB, no clock — trivially unit-testable.
 */
export interface SpecDiff {
  new: FlatParsedComponent[];
  changed: SpecDiffChanged[];
  dropped: SpecDiffDropped[];
  matchedKeyToId: Record<string, string>;
}

/** Flattens the recursive parsed tree into pre-order rows with parent links. */
export function flattenParsed(tree: ParsedComponent[]): FlatParsedComponent[] {
  const out: FlatParsedComponent[] = [];
  const walk = (nodes: ParsedComponent[], parentSpecKey: string | null) => {
    for (const node of nodes) {
      const flat: FlatParsedComponent = {
        specKey: node.specKey,
        parentSpecKey,
        kind: node.kind,
        title: node.title,
      };
      if (node.documentation !== undefined)
        flat.documentation = node.documentation;
      if (node.metadata !== undefined) flat.metadata = node.metadata;
      out.push(flat);
      if (node.children && node.children.length > 0) {
        walk(node.children, node.specKey);
      }
    }
  };
  walk(tree, null);
  return out;
}

/**
 * Classifies a parsed tree against the Spec's existing generated children by
 * `specKey`. Pure (ADR-0029); the service layer supplies `existing` (a DB read)
 * and later annotates dropped rows with incident-connection info.
 */
export function parseSpecDiff(
  tree: ParsedComponent[],
  existing: ExistingGeneratedComponent[],
): SpecDiff {
  const flat = flattenParsed(tree);
  const parsedByKey = new Map(flat.map((f) => [f.specKey, f]));
  const existingByKey = new Map(existing.map((e) => [e.specKey, e]));

  const created: FlatParsedComponent[] = [];
  const changed: SpecDiffChanged[] = [];
  const matchedKeyToId: Record<string, string> = {};

  for (const parsed of flat) {
    const match = existingByKey.get(parsed.specKey);
    if (match === undefined) {
      created.push(parsed);
      continue;
    }
    matchedKeyToId[parsed.specKey] = match.id;
    const fields = changedFields(parsed, match);
    if (fields.length > 0) {
      changed.push({
        specKey: parsed.specKey,
        nodeId: match.id,
        parsed,
        existing: match,
        changedFields: fields,
      });
    }
  }

  const dropped: SpecDiffDropped[] = [];
  for (const existingChild of existing) {
    if (!parsedByKey.has(existingChild.specKey)) {
      dropped.push({
        nodeId: existingChild.id,
        specKey: existingChild.specKey,
        title: existingChild.title,
      });
    }
  }

  return { new: created, changed, dropped, matchedKeyToId };
}

// The DERIVED fields that differ between a parsed node and its live match (empty
// => unchanged). Documentation is deliberately not compared — it is user-owned
// after first create (ADR-0029).
function changedFields(
  parsed: FlatParsedComponent,
  existing: ExistingGeneratedComponent,
): SpecChangedField[] {
  const fields: SpecChangedField[] = [];
  if (parsed.title !== existing.title) fields.push("title");
  if (parsed.kind !== existing.kind) fields.push("kind");
  if (!metadataEqual(parsed.metadata, existing.metadata)) fields.push("metadata");
  return fields;
}

// Order-insensitive structural equality for the metadata blob. Both sides
// normalize "no metadata" (undefined / null / {}) to the same canonical form so
// a re-parse of an unchanged spec does not report a spurious change.
function metadataEqual(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

function stableStringify(value: unknown): string {
  const normalized = normalize(value);
  return JSON.stringify(normalized);
}

function normalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => [k, normalize(v)] as const)
      .filter(([, v]) => v !== null)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (entries.length === 0) return null;
    return Object.fromEntries(entries);
  }
  return value;
}
