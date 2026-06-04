import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { READ_RESOURCES } from "../catalog";
import { WRITE_TOOLS } from "../tool-catalog";

const MANIFEST_PATH = join(
  process.cwd(),
  "skills/documenting-architecture-with-infinite-docs/manifest.json",
);

const manifestSchema = z.object({
  name: z.literal("documenting-architecture-with-infinite-docs"),
  mcp: z.object({
    endpointPath: z.string().min(1),
    discoveryDoc: z.string().min(1),
    resourceScheme: z.string().min(1),
    resources: z.array(z.string().min(1)),
    tools: z.array(z.string().min(1)),
    noDeleteTool: z.boolean(),
  }),
});

const manifest = manifestSchema.parse(
  JSON.parse(readFileSync(MANIFEST_PATH, "utf8")),
);

const catalogToolNames = WRITE_TOOLS.map((t) => t.name);
// A future `stability`/experimental flag on a descriptor would filter the
// reverse (catalog → manifest) check here, so the skill is not forced to teach
// a tool/resource that is not yet stable. No such flag exists today, so every
// catalog entry must appear in the manifest.
const catalogResourceNames = READ_RESOURCES.map((r) => r.name);

function missing(expected: string[], actual: string[]): string[] {
  const have = new Set(actual);
  return expected.filter((name) => !have.has(name));
}

function duplicates(names: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) dupes.add(name);
    seen.add(name);
  }
  return [...dupes];
}

describe("skill manifest drift guard", () => {
  it("names every write tool the catalog exposes, and no others", () => {
    expect(missing(catalogToolNames, manifest.mcp.tools)).toEqual([]);
    expect(missing(manifest.mcp.tools, catalogToolNames)).toEqual([]);
  });

  it("names every read resource the catalog exposes, and no others", () => {
    expect(missing(catalogResourceNames, manifest.mcp.resources)).toEqual([]);
    expect(missing(manifest.mcp.resources, catalogResourceNames)).toEqual([]);
  });

  it("lists each tool and resource exactly once", () => {
    expect(duplicates(manifest.mcp.tools)).toEqual([]);
    expect(duplicates(manifest.mcp.resources)).toEqual([]);
  });
});
