import { Parser } from "node-sql-parser";

import {
  isPlainObject,
  type ParsedFlow,
  type ParseFlowSpecResult,
} from "../shared";

/**
 * SQL DDL loader. Materializes one Flow per `CREATE TABLE` — the table is the
 * routable unit a database exposes to the components that read and write it,
 * the analog of an OpenAPI operation. Columns, primary keys, and foreign keys
 * are captured into the `signature` for documentation; foreign-key →
 * Connection materialization is intentionally deferred (the FK is recorded, not
 * drawn). Interaction is REQUEST: a consumer queries the table, so the arrow
 * points at the owning database (ADR-0023).
 *
 * `node-sql-parser` is a pure PEG parser — no connection, no execution — so on
 * UNTRUSTED source it only ever produces an AST or throws (we catch). The AST
 * shape varies across dialects and versions, so every field read below is
 * defensively guarded rather than trusting a static type. Dialect defaults to
 * PostgreSQL; a future input could let the owner pick (MySQL, T-SQL, …).
 */

const MAX_TABLES = 500;
const DIALECT = "postgresql";

const parser = new Parser();

interface ParsedColumn {
  name: string;
  type: string | null;
  nullable: boolean;
  key: "PK" | null;
}

export function parseSqlDdl(source: string): ParseFlowSpecResult {
  let ast: unknown;
  try {
    ast = parser.astify(source, { database: DIALECT });
  } catch {
    return {
      parseError: `Couldn't parse spec as SQL — input is not valid ${DIALECT} DDL.`,
    };
  }

  const statements = Array.isArray(ast) ? ast : [ast];
  const flows: ParsedFlow[] = [];

  for (const stmt of statements) {
    if (!isPlainObject(stmt)) continue;
    if (stmt.type !== "create" || stmt.keyword !== "table") continue;

    const tableName = firstTableName(stmt.table);
    if (!tableName) continue;

    if (flows.length >= MAX_TABLES) {
      return {
        parseError: `Couldn't parse spec as SQL — table count exceeds the cap (${MAX_TABLES}).`,
      };
    }

    const defs = Array.isArray(stmt.create_definitions)
      ? stmt.create_definitions
      : [];
    const primaryKey = collectPrimaryKey(defs);
    const columns = collectColumns(defs, primaryKey);
    const foreignKeys = collectForeignKeys(defs);

    flows.push({
      kind: "DB_TABLE",
      key: tableName,
      title: tableName,
      interaction: "REQUEST",
      signature: { table: tableName, columns, primaryKey, foreignKeys },
    });
  }

  return { flows };
}

function firstTableName(table: unknown): string | null {
  if (!Array.isArray(table) || table.length === 0) return null;
  const first: unknown = table[0];
  return isPlainObject(first) && typeof first.table === "string"
    ? first.table
    : null;
}

// A column reference's name nests differently across dialects/versions:
// `{ column: "name" }`, `{ column: { value } }`, or (node-sql-parser v5/pg)
// `{ column: { expr: { value } } }`. Pull out whichever string is in there.
function columnName(node: unknown): string | null {
  if (typeof node === "string") return node;
  if (!isPlainObject(node)) return null;
  const col = node.column;
  if (typeof col === "string") return col;
  if (isPlainObject(col)) {
    if (typeof col.value === "string") return col.value;
    if (isPlainObject(col.expr) && typeof col.expr.value === "string") {
      return col.expr.value;
    }
  }
  return null;
}

function collectColumns(
  defs: unknown[],
  primaryKey: string[],
): ParsedColumn[] {
  const pk = new Set(primaryKey);
  const columns: ParsedColumn[] = [];
  for (const def of defs) {
    if (!isPlainObject(def) || def.resource !== "column") continue;
    const name = columnName(def.column);
    if (!name) continue;
    const definition = isPlainObject(def.definition) ? def.definition : null;
    const type =
      definition && typeof definition.dataType === "string"
        ? definition.dataType
        : null;
    const inlinePrimary =
      typeof def.primary_key === "string" &&
      def.primary_key.toLowerCase().includes("primary");
    const notNull =
      isPlainObject(def.nullable) &&
      typeof def.nullable.type === "string" &&
      def.nullable.type.toLowerCase().includes("not null");
    columns.push({
      name,
      type,
      nullable: !(notNull || inlinePrimary || pk.has(name)),
      key: inlinePrimary || pk.has(name) ? "PK" : null,
    });
  }
  return columns;
}

function collectPrimaryKey(defs: unknown[]): string[] {
  const names: string[] = [];
  for (const def of defs) {
    if (!isPlainObject(def)) continue;
    if (
      def.resource === "column" &&
      typeof def.primary_key === "string" &&
      def.primary_key.toLowerCase().includes("primary")
    ) {
      const name = columnName(def.column);
      if (name) names.push(name);
      continue;
    }
    if (
      def.resource === "constraint" &&
      typeof def.constraint_type === "string" &&
      def.constraint_type.toLowerCase().includes("primary")
    ) {
      for (const col of asArray(def.definition)) {
        const name = columnName(col);
        if (name) names.push(name);
      }
    }
  }
  return names;
}

function collectForeignKeys(
  defs: unknown[],
): Array<{ columns: string[]; references: string | null }> {
  const fks: Array<{ columns: string[]; references: string | null }> = [];
  for (const def of defs) {
    if (!isPlainObject(def)) continue;
    if (
      def.resource !== "constraint" ||
      typeof def.constraint_type !== "string" ||
      !def.constraint_type.toLowerCase().includes("foreign")
    ) {
      continue;
    }
    const columns = asArray(def.definition)
      .map(columnName)
      .filter((n): n is string => n !== null);
    const ref = isPlainObject(def.reference_definition)
      ? firstTableName(def.reference_definition.table)
      : null;
    fks.push({ columns, references: ref });
  }
  return fks;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
