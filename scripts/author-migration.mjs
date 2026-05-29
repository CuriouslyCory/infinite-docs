#!/usr/bin/env node
// `pnpm db:author <name>` — scaffold a new Prisma migration directory and seed
// it with the incremental SQL diff between the live database (via the config
// datasource) and `prisma/schema.prisma`. Hand-edit the result for anything
// Prisma can't express (partial unique indexes, DO $$ guards, etc.) before
// applying with `pnpm db:migrate`. See ADR-0010 for the workflow rationale.
//
// Requires the live dev database to be up and at the head of the migration
// history (run `pnpm db:migrate` first if it has fallen behind). The diff is
// schema-vs-live-DB precisely because the repo deliberately does not configure
// a shadow database — `--from-migrations` would require one.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const rawName = process.argv[2];
if (!rawName) {
  console.error("Usage: pnpm db:author <name>");
  console.error("  e.g. pnpm db:author add_flow_models");
  process.exit(2);
}

// Sanitize: lowercase, collapse runs of non-alphanumerics to single underscore,
// strip leading/trailing underscores. Mirrors the existing migration names
// (`init`, `edge_dedup_partial_unique_index`).
const name = rawName
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

if (!name) {
  console.error(`Invalid migration name: ${JSON.stringify(rawName)}`);
  process.exit(2);
}

// Timestamp format: YYYYMMDDHHMMSS (UTC), matching Prisma's standard and the
// existing on-disk migrations so lexicographic order = chronological order.
const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const timestamp =
  now.getUTCFullYear().toString() +
  pad(now.getUTCMonth() + 1) +
  pad(now.getUTCDate()) +
  pad(now.getUTCHours()) +
  pad(now.getUTCMinutes()) +
  pad(now.getUTCSeconds());

const migrationDirName = `${timestamp}_${name}`;
const migrationDir = join(repoRoot, "prisma", "migrations", migrationDirName);
const migrationFile = join(migrationDir, "migration.sql");

if (existsSync(migrationDir)) {
  console.error(`Migration directory already exists: ${migrationDir}`);
  console.error("Pick a different name or wait one second and retry.");
  process.exit(1);
}

let sql;
try {
  sql = execFileSync(
    "pnpm",
    [
      "prisma",
      "migrate",
      "diff",
      "--from-config-datasource",
      "--to-schema",
      "prisma/schema.prisma",
      "--script",
    ],
    { cwd: repoRoot, encoding: "utf8" },
  );
} catch (error) {
  console.error("prisma migrate diff failed:");
  console.error(error.stderr ?? error.message);
  process.exit(error.status ?? 1);
}

// Detect "nothing to migrate" — Prisma emits only a comment line. Don't create
// an empty migration directory; tell the user there's nothing to author.
const hasRealStatements = sql
  .split("\n")
  .some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("--");
  });

if (!hasRealStatements) {
  console.log("Live DB matches prisma/schema.prisma — no migration needed.");
  console.log("(If you expected changes, confirm DATABASE_URL is the dev DB and");
  console.log(" that `pnpm db:migrate` has been run.)");
  process.exit(0);
}

mkdirSync(migrationDir, { recursive: true });
writeFileSync(migrationFile, sql);

console.log(`Created ${migrationFile}`);
console.log("");
console.log("Next steps:");
console.log("  1. Hand-edit the file for any raw SQL Prisma can't express");
console.log("     (partial unique indexes, DO $$ guards, etc.) — see");
console.log("     prisma/migrations/20260529012526_edge_dedup_partial_unique_index/");
console.log("     for the canonical template.");
console.log("  2. Apply with `pnpm db:migrate` (deploys + regenerates the client).");
console.log("  3. Commit the migration directory alongside the schema change.");
console.log("");
console.log("See ADR-0010 for the full workflow.");
