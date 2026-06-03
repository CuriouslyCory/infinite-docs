import { Parser } from "node-sql-parser";
import type {
  ComponentMetadata,
  ParsedComponent,
  ParsedConnection,
} from "~/lib/schemas";
import type { ParseResult, SpecParser } from "./types";

// Dialects to try, in order — the user may paste DDL from any of these and we
// pick the first that parses (Postgres and MySQL cover the vast majority;
// MySQL's mode also accepts backtick quoting). node-sql-parser's AST shape is
// version-fluid and loosely typed, so we walk it through `unknown` guards rather
// than trusting its declarations — robust against both dialect and version drift.
const DIALECTS = ["postgresql", "mysql", "sqlite", "mariadb"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * SQL-DDL parser (#64 / ADR-0029, #76): each `CREATE TABLE` becomes a Table
 * Component; each column a child Component (columns have no dedicated NodeKind,
 * so they are GENERIC — the parser-can't-infer fallback — with type/nullability/
 * PK in `metadata`). `specKey` anchors on the table name (column keys qualified
 * by it, so they stay unique across the tree). FOREIGN KEYs become Connections
 * between the referencing and referenced TABLE Components (#76) — directional
 * `REQUEST` (referencing → referenced); the per-FK `specKey` is the constraint
 * name when present. Built on `node-sql-parser` for a real AST instead of regex —
 * it handles quoting, parenthesized types, inline and table-level `PRIMARY KEY` /
 * `FOREIGN KEY`, out-of-line `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` (how
 * Prisma emits every FK), and multiple dialects.
 */
function parse(source: string): ParseResult {
  const parser = new Parser();
  let ast: unknown = null;
  let parsed = false;
  for (const database of DIALECTS) {
    try {
      ast = parser.astify(source, { database });
      parsed = true;
      break;
    } catch {
      // try the next dialect
    }
  }
  if (!parsed) {
    return {
      ok: false,
      parseError:
        "Could not parse as SQL DDL (tried PostgreSQL, MySQL, SQLite, MariaDB).",
    };
  }

  const statements = Array.isArray(ast) ? ast : [ast];
  const tables: ParsedComponent[] = [];
  const seenTables = new Set<string>();

  for (const statement of statements) {
    if (!isRecord(statement)) continue;
    if (statement.type !== "create" || statement.keyword !== "table") continue;

    const tableName = readTableName(statement.table);
    if (tableName === null) continue;
    if (seenTables.has(tableName)) {
      return {
        ok: false,
        parseError: `Duplicate table name: \`${tableName}\`.`,
      };
    }
    seenTables.add(tableName);

    const defs = Array.isArray(statement.create_definitions)
      ? statement.create_definitions
      : [];
    const tableResult = buildTable(tableName, defs);
    if (!tableResult.ok) {
      return tableResult;
    }
    tables.push(tableResult.tree);
  }

  if (tables.length === 0) {
    return {
      ok: false,
      parseError: "No `CREATE TABLE` statement found in the SQL.",
    };
  }

  const connections = collectConnections(statements, seenTables);
  return { ok: true, tree: tables, connections };
}

// All FK Connections in the DDL, ONE per ordered table → table pair. Two FK
// sources: out-of-line `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY` (Prisma's
// form) and in-line / table-level FKs inside `CREATE TABLE`.
//
// Why one Connection per PAIR, not per FK: a Connection models a dependency
// arrow between two Components, and the Edge de-dupe index forbids parallel
// REQUEST edges between the same ordered pair — so three FKs Edge→Node (e.g.
// canvasNodeId, sourceId, targetId) are ONE Connection whose label lists the
// columns, not three colliding edges. The pair `source->target` is the stable
// `specKey` so a re-parse reconciles it (#76 / ADR-0033).
//
// A self-referential FK (a table referencing itself, e.g. Node.parentId → Node)
// is skipped: the no-self-link invariant forbids a Connection from a Component to
// itself (`connectNodes`). An FK touching a table absent from the parse (partial
// paste) is dropped, never an error — the fail-soft posture the component parse
// uses.
function collectConnections(
  statements: unknown[],
  seenTables: Set<string>,
): ParsedConnection[] {
  interface PairAccumulator {
    sourceKey: string;
    targetKey: string;
    columns: string[];
  }
  const byPair = new Map<string, PairAccumulator>();

  const pushFk = (referencingTable: string, def: unknown): void => {
    const fk = readForeignKey(def);
    if (fk === null) return;
    if (referencingTable === fk.targetTable) return; // no self-link Connection
    if (!seenTables.has(referencingTable) || !seenTables.has(fk.targetTable)) {
      return;
    }
    const key = `${referencingTable}->${fk.targetTable}`;
    let entry = byPair.get(key);
    if (entry === undefined) {
      entry = {
        sourceKey: referencingTable,
        targetKey: fk.targetTable,
        columns: [],
      };
      byPair.set(key, entry);
    }
    for (const column of fk.sourceColumns) {
      if (!entry.columns.includes(column)) entry.columns.push(column);
    }
  };

  for (const statement of statements) {
    if (!isRecord(statement)) continue;
    if (statement.type === "create" && statement.keyword === "table") {
      const tableName = readTableName(statement.table);
      if (tableName === null) continue;
      const defs = Array.isArray(statement.create_definitions)
        ? statement.create_definitions
        : [];
      for (const def of defs) pushFk(tableName, def);
    } else if (statement.type === "alter" && statement.keyword === "table") {
      const tableName = readTableName(statement.table);
      if (tableName === null) continue;
      const exprs = Array.isArray(statement.expr) ? statement.expr : [];
      for (const expr of exprs) {
        if (!isRecord(expr)) continue;
        pushFk(tableName, expr.create_definitions);
      }
    }
  }

  return [...byPair.entries()].map(([key, entry]) => {
    const connection: ParsedConnection = {
      specKey: key.slice(0, 512),
      sourceKey: entry.sourceKey,
      targetKey: entry.targetKey,
      interaction: "REQUEST",
    };
    const label = entry.columns.join(", ");
    if (label.length > 0) connection.label = label.slice(0, 200);
    return connection;
  });
}

interface ForeignKey {
  sourceColumns: string[];
  targetTable: string;
  name: string | null;
}

// Reads a FOREIGN KEY out of a create-definition node — a table-level / ALTER
// constraint (`constraint_type` "foreign key", carrying `reference_definition`)
// or a column-level `REFERENCES` (a column def whose `reference_definition` is
// set). Returns null for anything else. node-sql-parser's `constraint_type`
// casing varies by dialect/version, so compare case-insensitively.
function readForeignKey(def: unknown): ForeignKey | null {
  if (!isRecord(def)) return null;
  const refDef = def.reference_definition;
  if (!isRecord(refDef)) return null;
  const targetTable = readTableName(refDef.table);
  if (targetTable === null) return null;
  const name = typeof def.constraint === "string" ? def.constraint : null;

  const constraintType =
    typeof def.constraint_type === "string"
      ? def.constraint_type.toLowerCase()
      : "";
  if (constraintType === "foreign key") {
    const sourceColumns = (Array.isArray(def.definition) ? def.definition : [])
      .map(readColumnRef)
      .filter((name): name is string => name !== null);
    return { sourceColumns, targetTable, name };
  }
  if (def.resource === "column") {
    const column = readColumnRef(def.column);
    if (column === null) return null;
    return { sourceColumns: [column], targetTable, name };
  }
  return null;
}

// One table's outcome: a single Component on success, or a parse error (a
// duplicate column anchor — never a partial table). Distinct from `ParseResult`,
// whose `tree` is the array of top-level tables.
type TableResult =
  | { ok: true; tree: ParsedComponent }
  | { ok: false; parseError: string };

function buildTable(tableName: string, defs: unknown[]): TableResult {
  const pkColumns = new Set<string>();
  for (const def of defs) {
    if (!isRecord(def)) continue;
    if (
      def.resource === "constraint" &&
      def.constraint_type === "primary key"
    ) {
      for (const ref of Array.isArray(def.definition) ? def.definition : []) {
        const name = readColumnRef(ref);
        if (name !== null) pkColumns.add(name.toLowerCase());
      }
    }
  }

  const seen = new Set<string>();
  const children: ParsedComponent[] = [];
  for (const def of defs) {
    if (!isRecord(def) || def.resource !== "column") continue;
    const column = buildColumn(tableName, def, pkColumns);
    if (column === null) continue;
    if (seen.has(column.specKey)) {
      return {
        ok: false,
        parseError: `Duplicate column in table \`${tableName}\`: \`${column.title}\`.`,
      };
    }
    seen.add(column.specKey);
    children.push(column);
  }

  const table: ParsedComponent = {
    specKey: tableName,
    kind: "TABLE",
    title: tableName,
  };
  if (children.length > 0) table.children = children;
  return { ok: true, tree: table };
}

function buildColumn(
  tableName: string,
  def: Record<string, unknown>,
  pkColumns: Set<string>,
): ParsedComponent | null {
  const name = readColumnRef(def.column);
  if (name === null) return null;

  const inlinePk = def.primary_key === "primary key";
  const primaryKey = inlinePk || pkColumns.has(name.toLowerCase());
  const notNull = isRecord(def.nullable) && def.nullable.type === "not null";

  const metadata: ComponentMetadata = {
    nullable: !notNull && !primaryKey,
    primaryKey,
  };
  const dataType = formatDataType(def.definition);
  if (dataType.length > 0) metadata.dataType = dataType;

  return {
    specKey: `${tableName}.${name}`,
    kind: "GENERIC",
    title: name,
    metadata,
  };
}

// `table` is an array of `{ db, table }` refs; keep the (unqualified) table name.
function readTableName(table: unknown): string | null {
  const first: unknown = Array.isArray(table) ? table[0] : table;
  if (!isRecord(first)) return null;
  return typeof first.table === "string" ? first.table : null;
}

// A column ref is either `{ column: "name" }` or, in newer ASTs,
// `{ column: { expr: { value: "name" } } }`. Handle both.
function readColumnRef(ref: unknown): string | null {
  if (typeof ref === "string") return ref;
  if (!isRecord(ref)) return null;
  const column = ref.column;
  if (typeof column === "string") return column;
  if (isRecord(column) && isRecord(column.expr)) {
    const value = column.expr.value;
    if (typeof value === "string") return value;
  }
  return null;
}

// Reconstructs `VARCHAR(255)` / `NUMERIC(10,2)` from the definition's parts.
function formatDataType(definition: unknown): string {
  if (!isRecord(definition)) return "";
  const dataType =
    typeof definition.dataType === "string" ? definition.dataType : "";
  if (dataType.length === 0) return "";
  const length = definition.length;
  const scale = definition.scale;
  if (typeof length === "number" && typeof scale === "number") {
    return `${dataType}(${length},${scale})`;
  }
  if (typeof length === "number") return `${dataType}(${length})`;
  return dataType;
}

export const sqlDdlParser: SpecParser = { parse };
