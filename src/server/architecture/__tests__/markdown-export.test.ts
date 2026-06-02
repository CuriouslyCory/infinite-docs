import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { NotFoundError } from "../errors";
import { exportMarkdown } from "../export.service";
import {
  serializeGraph,
  type SerializerEdge,
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
        interaction: "REQUEST",
        label: "reads from",
      },
      {
        id: "e-api-ext",
        sourceId: "n-api",
        targetId: "n-ext",
        interaction: "REQUEST",
        label: "calls",
      },
      {
        id: "e-auth-users",
        sourceId: "n-auth",
        targetId: "n-users",
        interaction: "ASSOCIATION",
        label: null,
      },
      // Descendant→external: incident to n-users (a child of the n-api subtree
      // root), NOT to n-api itself. In the subtree export this surfaces as ONE
      // per-edge Boundary row (the `direct/inherited` partition is retired;
      // ADR-0031 / #67 amendment).
      {
        id: "e-users-analytics",
        sourceId: "n-users",
        targetId: "n-analytics",
        interaction: "PUSH",
        label: "tracks events",
      },
    ],
    boundaryEdges: [],
    mode: "full",
  };
}

/**
 * Subtree input: the API Gateway and its children, with the three crossing
 * Connections surfaced as per-edge Boundary rows (the export must be
 * self-describing — AC). Each row carries the full Connection plus the
 * denormalized far-end Component fields; the `direct/inherited` partition
 * is retired (ADR-0031 / #67 amendment).
 */
function buildSubtreeInput(): SerializerInput {
  const root = buildProjectInput();
  const subtreeIds = new Set(["n-api", "n-auth", "n-users"]);
  return {
    project: root.project,
    rootCanvasNodeId: "n-api",
    nodes: root.nodes.filter((n) => subtreeIds.has(n.id)),
    // Internal Connections: both endpoints inside the subtree (ADR-0028).
    edges: root.edges.filter(
      (e) => subtreeIds.has(e.sourceId) && subtreeIds.has(e.targetId),
    ),
    boundaryEdges: [
      {
        edgeId: "e-api-db",
        sourceId: "n-api",
        targetId: "n-db",
        interaction: "REQUEST",
        label: "reads from",
        farEndpointId: "n-db",
        farTitle: "Postgres",
        farKind: "DATABASE",
      },
      {
        edgeId: "e-api-ext",
        sourceId: "n-api",
        targetId: "n-ext",
        interaction: "REQUEST",
        label: "calls",
        farEndpointId: "n-ext",
        farTitle: "Third Party API",
        farKind: "EXTERNAL_API",
      },
      // Reached only via n-users (a descendant of the root). Under the retired
      // partition this would have been "inherited"; per-edge it is just one
      // more crossing Connection row — no special class.
      {
        edgeId: "e-users-analytics",
        sourceId: "n-users",
        targetId: "n-analytics",
        interaction: "PUSH",
        label: "tracks events",
        farEndpointId: "n-analytics",
        farTitle: "Analytics API",
        farKind: "EXTERNAL_API",
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
          documentation: "# Real heading\n\n```\n# not a heading\n```\n",
        },
      ],
      edges: [],
      boundaryEdges: [],
      mode: "full",
    };
    const md = serializeGraph(input);
    // The real heading is shifted to depth 4; the fenced literal is intact.
    expect(md).toContain("#### Real heading");
    expect(md).toContain("```\n# not a heading\n```");
  });

  // The four-glyph mapping is the canonical translation of `arrowEnds()`'s
  // booleans into rendering language (ADR-0027 + #67 amendment): the canvas
  // maps to React Flow markers, the exporter maps to glyphs. These cases lock
  // the exporter half so a future Interaction value forces a deliberate update.
  describe("interaction glyphs", () => {
    function projectWithEdge(interaction: SerializerEdge["interaction"]): SerializerInput {
      return {
        project: { title: "G" },
        rootCanvasNodeId: null,
        nodes: [
          {
            id: "n-a",
            parentId: null,
            title: "A",
            kind: "SERVICE",
            documentation: "",
          },
          {
            id: "n-b",
            parentId: null,
            title: "B",
            kind: "SERVICE",
            documentation: "",
          },
        ],
        edges: [
          {
            id: "e-ab",
            sourceId: "n-a",
            targetId: "n-b",
            interaction,
            label: null,
          },
        ],
        boundaryEdges: [],
        mode: "full",
      };
    }

    it("renders ASSOCIATION as `—` (no arrowheads)", () => {
      expect(serializeGraph(projectWithEdge("ASSOCIATION"))).toContain(
        "- A {#n-a} — B {#n-b}",
      );
    });
    it("renders REQUEST as `→` (arrow at target)", () => {
      expect(serializeGraph(projectWithEdge("REQUEST"))).toContain(
        "- A {#n-a} → B {#n-b}",
      );
    });
    it("renders PUSH as `→` (arrow at target)", () => {
      expect(serializeGraph(projectWithEdge("PUSH"))).toContain(
        "- A {#n-a} → B {#n-b}",
      );
    });
    it("renders SUBSCRIBE as `←` (arrow at source)", () => {
      expect(serializeGraph(projectWithEdge("SUBSCRIBE"))).toContain(
        "- A {#n-a} ← B {#n-b}",
      );
    });
    it("renders DUPLEX as `↔` (arrows at both ends)", () => {
      expect(serializeGraph(projectWithEdge("DUPLEX"))).toContain(
        "- A {#n-a} ↔ B {#n-b}",
      );
    });
  });

  // The data layer never coalesces boundary proxies by far Node (ADR-0031):
  // a single external reached by N crossing Connections must render N
  // Boundary rows. Tests the export's per-edge derivation on the serializer
  // side — the integration test below proves the DB fetch produces the same
  // shape.
  it("renders one Boundary row per crossing Connection (no coalescing)", () => {
    const input: SerializerInput = {
      project: { title: "P" },
      rootCanvasNodeId: "n-root",
      nodes: [
        {
          id: "n-root",
          parentId: null,
          title: "Root",
          kind: "SERVICE",
          documentation: "",
        },
        {
          id: "n-x",
          parentId: "n-root",
          title: "X",
          kind: "SERVICE",
          documentation: "",
        },
        {
          id: "n-y",
          parentId: "n-root",
          title: "Y",
          kind: "SERVICE",
          documentation: "",
        },
      ],
      edges: [],
      boundaryEdges: [
        {
          edgeId: "e-x-ext",
          sourceId: "n-x",
          targetId: "n-ext",
          interaction: "REQUEST",
          label: null,
          farEndpointId: "n-ext",
          farTitle: "External",
          farKind: "EXTERNAL_API",
        },
        {
          edgeId: "e-y-ext",
          sourceId: "n-y",
          targetId: "n-ext",
          interaction: "PUSH",
          label: null,
          farEndpointId: "n-ext",
          farTitle: "External",
          farKind: "EXTERNAL_API",
        },
      ],
      mode: "full",
    };
    const md = serializeGraph(input);
    const lines = md.split("\n").filter((l) => l.includes("{#n-ext}"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("n-x");
    expect(lines[1]).toContain("n-y");
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
        interaction: e.interaction,
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

  // The boundary CTE must NOT coalesce by far Node — two children of the
  // subtree root, both wired to the same external Component, must produce
  // two Boundary rows (ADR-0031 / #67 amendment, the export consumer of the
  // per-edge posture).
  it("derives per-edge Boundary rows when multiple children share one external", async () => {
    const user = await testDb.user.create({
      data: { id: "u-be", name: "Boundary owner" },
    });
    await testDb.project.create({
      data: {
        id: "p-be",
        title: "Boundary project",
        slug: "be-slug",
        ownerId: user.id,
      },
    });
    await testDb.node.create({
      data: {
        id: "n-be-root",
        projectId: "p-be",
        parentId: null,
        title: "Root",
        kind: "SERVICE",
      },
    });
    await testDb.node.create({
      data: {
        id: "n-be-x",
        projectId: "p-be",
        parentId: "n-be-root",
        title: "X",
        kind: "SERVICE",
      },
    });
    await testDb.node.create({
      data: {
        id: "n-be-y",
        projectId: "p-be",
        parentId: "n-be-root",
        title: "Y",
        kind: "SERVICE",
      },
    });
    await testDb.node.create({
      data: {
        id: "n-be-ext",
        projectId: "p-be",
        parentId: null,
        title: "Ext",
        kind: "EXTERNAL_API",
      },
    });
    await testDb.edge.create({
      data: {
        id: "e-be-x",
        projectId: "p-be",
        sourceId: "n-be-x",
        targetId: "n-be-ext",
        interaction: "REQUEST",
      },
    });
    await testDb.edge.create({
      data: {
        id: "e-be-y",
        projectId: "p-be",
        sourceId: "n-be-y",
        targetId: "n-be-ext",
        interaction: "PUSH",
      },
    });

    const { markdown } = await exportMarkdown(testDb, null, {
      slug: "be-slug",
      canvasNodeId: "n-be-root",
      mode: "full",
    });

    // Both crossing Connections appear under Boundary context (one row each),
    // never coalesced into a single "Ext" entry.
    const boundaryLines = markdown
      .split("\n")
      .filter((l) => l.includes("{#n-be-ext}"));
    expect(boundaryLines).toHaveLength(2);
    expect(markdown).toContain("X {#n-be-x} → Ext {#n-be-ext}");
    expect(markdown).toContain("Y {#n-be-y} → Ext {#n-be-ext}");
  });

  // Generated Components (#64 / ADR-0029) serialize as ORDINARY Components
  // with their `{#nodeId}` anchor — no special arm, no "generated" marker
  // in the output. Their Node ids stay stable across re-parse because
  // `parseSpecDiff` preserves them on matched `specKey` rows, so the anchor
  // is byte-stable too.
  it("renders a generated Component as an ordinary Component with a stable anchor", async () => {
    const user = await testDb.user.create({
      data: { id: "u-gen", name: "Spec owner" },
    });
    await testDb.project.create({
      data: {
        id: "p-gen",
        title: "Spec project",
        slug: "gen-slug",
        ownerId: user.id,
      },
    });
    await testDb.node.create({
      data: {
        id: "n-api-root",
        projectId: "p-gen",
        parentId: null,
        title: "Pets API",
        kind: "EXTERNAL_API",
      },
    });
    const spec = await testDb.spec.create({
      data: {
        projectId: "p-gen",
        ownerNodeId: "n-api-root",
        kind: "OPENAPI",
        source: "openapi: 3.0.0",
      },
    });
    await testDb.node.create({
      data: {
        id: "n-gen-endpoint",
        projectId: "p-gen",
        parentId: "n-api-root",
        title: "List pets",
        kind: "ENDPOINT",
        sourceSpecId: spec.id,
        specKey: "GET /pets",
      },
    });

    const { markdown } = await exportMarkdown(testDb, null, {
      slug: "gen-slug",
      canvasNodeId: null,
      mode: "full",
    });

    // Anchor present, rendered as an ordinary Component (kind: Endpoint), no
    // provenance markup leaks into the output.
    expect(markdown).toContain("### List pets {#n-gen-endpoint}");
    expect(markdown).toContain("- kind: Endpoint");
    expect(markdown).not.toMatch(/sourceSpec|specKey|generated/i);
  });
});
