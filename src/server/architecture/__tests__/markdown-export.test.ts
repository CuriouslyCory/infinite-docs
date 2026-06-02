import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { NotFoundError } from "../errors";
import { exportMarkdown } from "../export.service";
import {
  serializeGraph,
  type SerializerInput,
} from "../markdown";
import { resetDb, testDb } from "./helpers/test-db";

beforeEach(async () => {
  await resetDb();
});

const FIXTURES_DIR = resolve(__dirname, "fixtures");
const UPDATE = process.env.UPDATE_FIXTURES === "1";

/**
 * Byte-equality assertion against a golden file. When `UPDATE_FIXTURES=1`
 * the actual output is written to disk instead — the standard golden-file
 * escape hatch for intentional format changes (see fixtures/README.md).
 */
function assertGolden(actual: string, fixtureFile: string): void {
  const path = resolve(FIXTURES_DIR, fixtureFile);
  if (UPDATE) {
    writeFileSync(path, actual, "utf-8");
    return;
  }
  const expected = readFileSync(path, "utf-8");
  expect(actual).toBe(expected);
}

/**
 * The deterministic in-memory graph used by the pure serializer tests. Fixed
 * ids on every node + edge: cuids would be random, breaking byte-equality.
 * Shapes mirror what `exportMarkdown` would pass after the DB round trip.
 */
function buildProjectInput(): SerializerInput {
  return {
    project: { title: "Test System" },
    rootCanvasNodeId: null,
    nodes: [
      {
        id: "n-api",
        parentId: null,
        title: "API Gateway",
        kind: "SERVICE",
        documentation:
          "# Overview\n\nThis service exposes the public API.\n\n## Authentication\n\nTokens are JWT-based.\n",
      },
      {
        id: "n-auth",
        parentId: "n-api",
        title: "Auth Module",
        kind: "SERVICE",
        documentation: "",
      },
      {
        id: "n-db",
        parentId: null,
        title: "Postgres",
        kind: "DATABASE",
        documentation: "",
      },
      {
        id: "n-ext",
        parentId: null,
        title: "Third Party API",
        kind: "EXTERNAL_API",
        documentation: "",
      },
      {
        id: "n-users",
        parentId: "n-api",
        title: "Users Module",
        kind: "SERVICE",
        documentation: "",
      },
      {
        id: "n-analytics",
        parentId: null,
        title: "Analytics API",
        kind: "EXTERNAL_API",
        documentation: "",
      },
    ],
    edges: [
      {
        id: "e-api-db",
        sourceId: "n-api",
        targetId: "n-db",
        label: "reads from",
      },
      {
        id: "e-api-ext",
        sourceId: "n-api",
        targetId: "n-ext",
        label: "calls",
      },
      {
        id: "e-auth-users",
        sourceId: "n-auth",
        targetId: "n-users",
        label: null,
      },
      // Descendant→external: incident to n-users (a child of the n-api subtree
      // root), NOT to n-api itself. In the subtree export this surfaces n-analytics
      // as an "inherited" boundary proxy (is_direct = false), the complement of
      // the "direct" externals incident to the root.
      {
        id: "e-users-analytics",
        sourceId: "n-users",
        targetId: "n-analytics",
        label: "tracks events",
      },
    ],
    boundaryProxies: [],
    mode: "full",
  };
}

/**
 * Subtree input: the API Gateway and its children, with the two externals
 * lifted into Boundary context (they sit on the parent Canvas and a subtree
 * export must be self-describing — AC).
 */
function buildSubtreeInput(): SerializerInput {
  const root = buildProjectInput();
  return {
    project: root.project,
    rootCanvasNodeId: "n-api",
    nodes: root.nodes.filter((n) =>
      ["n-api", "n-auth", "n-users"].includes(n.id),
    ),
    // Internal Connections: both endpoints inside the subtree (ADR-0028).
    edges: root.edges.filter(
      (e) =>
        ["n-api", "n-auth", "n-users"].includes(e.sourceId) &&
        ["n-api", "n-auth", "n-users"].includes(e.targetId),
    ),
    boundaryProxies: [
      {
        nodeId: "n-db",
        title: "Postgres",
        kind: "DATABASE",
        origin: "direct",
      },
      {
        nodeId: "n-ext",
        title: "Third Party API",
        kind: "EXTERNAL_API",
        origin: "direct",
      },
      // Reached only via n-users (a descendant), never the subtree root — so the
      // service derives is_direct = false. Exercises the inherited boundary branch.
      {
        nodeId: "n-analytics",
        title: "Analytics API",
        kind: "EXTERNAL_API",
        origin: "inherited",
      },
    ],
    mode: "full",
  };
}

describe("serializeGraph (pure, deterministic)", () => {
  it("renders the project export byte-equal to the golden fixture", () => {
    const md = serializeGraph(buildProjectInput());
    assertGolden(md, "export-project-full.md");
  });

  it("renders the subtree export byte-equal to the golden fixture, with Boundary context", () => {
    const md = serializeGraph(buildSubtreeInput());
    assertGolden(md, "export-subtree-full.md");
  });

  it("renders the index export byte-equal to the golden fixture", () => {
    const md = serializeGraph({ ...buildProjectInput(), mode: "index" });
    assertGolden(md, "export-project-index.md");
  });

  it("is deterministic: the same graph serializes to the same bytes twice", () => {
    const a = serializeGraph(buildProjectInput());
    const b = serializeGraph(buildProjectInput());
    expect(a).toBe(b);
  });

  it("is locale-invariant: mutating process locale does not change the output", () => {
    const before = serializeGraph(buildProjectInput());
    const prior = {
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      LC_COLLATE: process.env.LC_COLLATE,
    };
    try {
      process.env.LANG = "fr_FR.UTF-8";
      process.env.LC_ALL = "fr_FR.UTF-8";
      process.env.LC_COLLATE = "fr_FR.UTF-8";
      const after = serializeGraph(buildProjectInput());
      expect(after).toBe(before);
    } finally {
      process.env.LANG = prior.LANG;
      process.env.LC_ALL = prior.LC_ALL;
      process.env.LC_COLLATE = prior.LC_COLLATE;
    }
  });

  it("heading-shifts authored docs via AST, never via regex", () => {
    // A doc with a sibling `# Heading` line inside a fenced code block — a
    // regex that matched lines starting with `#` would shift the code-block
    // text too, breaking the doc. The AST transform leaves it alone.
    const input: SerializerInput = {
      project: { title: "P" },
      rootCanvasNodeId: null,
      nodes: [
        {
          id: "n-x",
          parentId: null,
          title: "X",
          kind: "GENERIC",
          documentation:
            "# Real heading\n\n```\n# not a heading\n```\n",
        },
      ],
      edges: [],
      boundaryProxies: [],
      mode: "full",
    };
    const md = serializeGraph(input);
    // The real heading is shifted to depth 4; the fenced literal is intact.
    expect(md).toContain("#### Real heading");
    expect(md).toContain("```\n# not a heading\n```");
  });
});

/**
 * Integration: the fetch service plumbs the same shape into `serializeGraph`
 * that the pure tests above pin. Uses the real test DB (ADR-0003) and direct
 * inserts with fixed ids so the output matches the golden fixtures byte-for-
 * byte — proving the fetch / serialize seam end-to-end.
 */
async function seedProject(): Promise<string> {
  const user = await testDb.user.create({
    data: { id: "u-owner", name: "Owner" },
  });
  await testDb.project.create({
    data: {
      id: "p-test",
      title: "Test System",
      slug: "test-slug",
      ownerId: user.id,
    },
  });
  const input = buildProjectInput();
  for (const n of input.nodes) {
    await testDb.node.create({
      data: {
        id: n.id,
        projectId: "p-test",
        parentId: n.parentId,
        title: n.title,
        kind: n.kind,
        documentation: n.documentation,
      },
    });
  }
  for (const e of input.edges) {
    await testDb.edge.create({
      data: {
        id: e.id,
        projectId: "p-test",
        sourceId: e.sourceId,
        targetId: e.targetId,
        label: e.label,
      },
    });
  }
  return "test-slug";
}

describe("exportMarkdown (service, real DB)", () => {
  it("renders the project export identically to the golden fixture", async () => {
    const slug = await seedProject();
    const { markdown } = await exportMarkdown(testDb, null, {
      slug,
      canvasNodeId: null,
      mode: "full",
    });
    assertGolden(markdown, "export-project-full.md");
  });

  it("renders the subtree export with its Boundary context", async () => {
    const slug = await seedProject();
    const { markdown } = await exportMarkdown(testDb, null, {
      slug,
      canvasNodeId: "n-api",
      mode: "full",
    });
    assertGolden(markdown, "export-subtree-full.md");
  });

  it("renders the index mode for a project", async () => {
    const slug = await seedProject();
    const { markdown } = await exportMarkdown(testDb, null, {
      slug,
      canvasNodeId: null,
      mode: "index",
    });
    assertGolden(markdown, "export-project-index.md");
  });

  it("throws NotFound for a missing slug", async () => {
    await expect(
      exportMarkdown(testDb, null, {
        slug: "does-not-exist",
        canvasNodeId: null,
        mode: "full",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFound for a subtree scope that does not resolve to a live Node", async () => {
    const slug = await seedProject();
    await expect(
      exportMarkdown(testDb, null, {
        slug,
        canvasNodeId: "not-a-real-node",
        mode: "full",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
