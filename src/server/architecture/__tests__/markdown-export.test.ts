import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { type Actor } from "../actor";
import { connectCrossProject } from "../edge.service";
import { NotFoundError } from "../errors";
import { exportMarkdown } from "../export.service";
import {
  serializeGraph,
  serializeTrace,
  type SerializerEdge,
  type SerializerInput,
  type SerializerTraceInput,
} from "../markdown";
import {
  createEmbeddedComponent,
  createNode,
} from "../node.service";
import { createProject } from "../project.service";
import { getTraceMarkdownForActor } from "../trace.service";
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

/**
 * The determinism fixture: `buildProjectInput()` plus cross-project reference
 * markers (#123 / ADR-0044). The golden-file tests deliberately stay on the
 * marker-free `buildProjectInput()` (the three frozen fixtures assert byte-
 * stability of real exports). This variant exists so the twice-equal + locale-
 * mutation determinism tests actually exercise the marker sort comparators
 * (`renderCrossProjectReferences`), making the ADR-0017 marker-determinism claim
 * true. Input order is intentionally UNSORTED across every tiebreaker
 * (`hostNodeId`, `foreignProjectTitle`, `foreignEndpointTitle`, `interaction`)
 * so a non-stable sort or a locale-sensitive comparator would change the bytes.
 */
function buildDeterminismInput(): SerializerInput {
  return {
    ...buildProjectInput(),
    portalMarkers: [
      // n-db sorts AFTER n-api; the two n-api rows force the foreignProjectTitle
      // tiebreak (Zebra before Alpha in input → Alpha must come first out).
      {
        hostNodeId: "n-db",
        hostTitle: "Postgres",
        foreignProjectTitle: "Backup Store",
      },
      {
        hostNodeId: "n-api",
        hostTitle: "API Gateway",
        foreignProjectTitle: "Zebra Service",
      },
      {
        hostNodeId: "n-api",
        hostTitle: "API Gateway",
        foreignProjectTitle: "Alpha Service",
      },
    ],
    crossProjectMarkers: [
      // All share hostNodeId + foreignProjectTitle, so foreignEndpointTitle then
      // interaction drive the order (Refund before Charge in input; PUSH vs
      // REQUEST within the Charge group — input lists REQUEST first).
      {
        hostNodeId: "n-api",
        hostTitle: "API Gateway",
        foreignProjectTitle: "Payments",
        foreignEndpointTitle: "Refund",
        interaction: "REQUEST",
        label: "issues",
      },
      {
        hostNodeId: "n-api",
        hostTitle: "API Gateway",
        foreignProjectTitle: "Payments",
        foreignEndpointTitle: "Charge",
        interaction: "REQUEST",
        label: null,
      },
      {
        hostNodeId: "n-api",
        hostTitle: "API Gateway",
        foreignProjectTitle: "Payments",
        foreignEndpointTitle: "Charge",
        interaction: "PUSH",
        label: null,
      },
    ],
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
    // Marker-bearing fixture so the cross-project marker sort is in the bytes
    // under test (ADR-0017 marker-determinism claim).
    const input = buildDeterminismInput();
    const a = serializeGraph(input);
    const b = serializeGraph(input);
    expect(a).toBe(b);
    // Guard: the markers genuinely render, so this test actually exercises the
    // marker sort (a regression that dropped the section would still pass a
    // bare twice-equal, but not this).
    expect(a).toContain("## Cross-project references");
    expect(a).toContain("### Embedded projects");
    expect(a).toContain("### Cross-project connections");
  });

  it("is locale-invariant: mutating process locale does not change the output", () => {
    const input = buildDeterminismInput();
    const before = serializeGraph(input);
    expect(before).toContain("## Cross-project references");
    const prior = {
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      LC_COLLATE: process.env.LC_COLLATE,
    };
    try {
      process.env.LANG = "fr_FR.UTF-8";
      process.env.LC_ALL = "fr_FR.UTF-8";
      process.env.LC_COLLATE = "fr_FR.UTF-8";
      const after = serializeGraph(input);
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
    function projectWithEdge(
      interaction: SerializerEdge["interaction"],
    ): SerializerInput {
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
 * A fixed-id Trace serializer input (cuids would break byte-equality). Two
 * trace points across DIFFERENT layers (`n-users` is nested under `n-api`,
 * `n-db` is a root) so the multi-layer Components ordering and `path:` lines are
 * exercised; the on-path closure pulls in the intermediate `n-api` and its
 * ancestor. One Component carries authored docs with a `#`-line inside a fenced
 * code block (the AST heading-shift round-trip guard).
 */
function buildTraceInput(): SerializerTraceInput {
  return {
    project: { title: "Test System" },
    traceName: "Auth → DB",
    nodes: [
      {
        id: "n-api",
        parentId: null,
        title: "API Gateway",
        kind: "SERVICE",
        documentation:
          "# Overview\n\nRoutes requests.\n\n```\n# not a heading\n```\n",
      },
      {
        id: "n-users",
        parentId: "n-api",
        title: "Users Module",
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
    ],
    edges: [
      {
        id: "e-users-db",
        sourceId: "n-users",
        targetId: "n-db",
        interaction: "REQUEST",
        label: "reads from",
      },
    ],
    tracePointIds: ["n-users", "n-db"],
    truncated: false,
    warning: null,
  };
}

describe("serializeTrace (pure, deterministic)", () => {
  it("renders the trace export byte-equal to the golden fixture", () => {
    assertGolden(serializeTrace(buildTraceInput()), "export-trace-full.md");
  });

  it("is deterministic: the same trace serializes to the same bytes twice", () => {
    expect(serializeTrace(buildTraceInput())).toBe(
      serializeTrace(buildTraceInput()),
    );
  });

  it("is locale-invariant: mutating process locale does not change the output", () => {
    const before = serializeTrace(buildTraceInput());
    const prior = {
      LANG: process.env.LANG,
      LC_ALL: process.env.LC_ALL,
      LC_COLLATE: process.env.LC_COLLATE,
    };
    try {
      process.env.LANG = "fr_FR.UTF-8";
      process.env.LC_ALL = "fr_FR.UTF-8";
      process.env.LC_COLLATE = "fr_FR.UTF-8";
      expect(serializeTrace(buildTraceInput())).toBe(before);
    } finally {
      process.env.LANG = prior.LANG;
      process.env.LC_ALL = prior.LC_ALL;
      process.env.LC_COLLATE = prior.LC_COLLATE;
    }
  });

  it("surfaces a truncation warning blockquote when truncated", () => {
    const md = serializeTrace({
      ...buildTraceInput(),
      truncated: true,
      warning: "Showing the first 500 Components — refine your trace points.",
    });
    expect(md).toContain(
      "> ⚠ Showing the first 500 Components — refine your trace points.",
    );
  });

  it("heading-shifts authored docs via AST, never via regex", () => {
    const md = serializeTrace(buildTraceInput());
    expect(md).toContain("#### Overview");
    expect(md).toContain("```\n# not a heading\n```");
  });

  it("shows an insufficient-points note for a degenerate (< 2 live points) trace", () => {
    const md = serializeTrace({
      project: { title: "P" },
      traceName: "Lonely",
      nodes: [],
      edges: [],
      tracePointIds: ["n-only"],
      truncated: false,
      warning: null,
    });
    expect(md).toContain("Fewer than two live trace points");
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

/**
 * Integration: the member-aware MCP Trace read (#60, member parity #109). Seeds
 * a user + project + nodes + edges + a saved Trace with two cross-layer trace
 * points (direct inserts, fixed ids — ADR-0003) and asserts the owner-or-member
 * scoping + non-disclosure posture end-to-end, plus the degenerate empty state.
 */
async function seedTrace(ownerId: string): Promise<{
  traceId: string;
  usersNodeId: string;
}> {
  await testDb.project.create({
    data: { id: "p-trace", title: "Test System", slug: "trace-slug", ownerId },
  });
  await testDb.node.createMany({
    data: [
      {
        id: "tn-api",
        projectId: "p-trace",
        parentId: null,
        title: "API Gateway",
        kind: "SERVICE",
      },
      {
        id: "tn-users",
        projectId: "p-trace",
        parentId: "tn-api",
        title: "Users Module",
        kind: "SERVICE",
      },
      {
        id: "tn-db",
        projectId: "p-trace",
        parentId: null,
        title: "Postgres",
        kind: "DATABASE",
      },
    ],
  });
  await testDb.edge.create({
    data: {
      id: "te-users-db",
      projectId: "p-trace",
      sourceId: "tn-users",
      targetId: "tn-db",
      interaction: "REQUEST",
      label: "reads from",
    },
  });
  const trace = await testDb.trace.create({
    data: {
      projectId: "p-trace",
      name: "Auth → DB",
      points: { create: [{ nodeId: "tn-users" }, { nodeId: "tn-db" }] },
    },
    select: { id: true },
  });
  return { traceId: trace.id, usersNodeId: "tn-users" };
}

describe("getTraceMarkdownForActor (service, real DB)", () => {
  it("renders the owner's own Trace as deterministic markdown", async () => {
    const owner = await testDb.user.create({ data: { name: "Owner" } });
    const { traceId } = await seedTrace(owner.id);

    const { markdown } = await getTraceMarkdownForActor(
      testDb,
      { userId: owner.id, via: "token" },
      { traceId },
    );

    expect(markdown).toContain("# Test System — Trace: Auth → DB");
    expect(markdown).toContain("## Trace points");
    expect(markdown).toContain("{#tn-users}");
    expect(markdown).toContain("{#tn-db}");
    // The intermediate on-path Component and the Connection are present.
    expect(markdown).toContain("### Users Module {#tn-users}");
    expect(markdown).toContain(
      "Users Module {#tn-users} → Postgres {#tn-db} · reads from",
    );
  });

  // Deny → NotFoundError (non-disclosure): a non-member token cannot tell a
  // Trace it may not read from one that does not exist (ADR-0002/0040, #109).
  it("reports a Trace in another user's project as not-found (headline cross-owner test)", async () => {
    const owner = await testDb.user.create({ data: { name: "Owner" } });
    const intruder = await testDb.user.create({ data: { name: "Intruder" } });
    const { traceId } = await seedTrace(owner.id);

    await expect(
      getTraceMarkdownForActor(
        testDb,
        { userId: intruder.id, via: "token" },
        { traceId },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // Member parity (#109): an EDITOR member of the Trace's project reads it.
  it("renders a Trace for an EDITOR member of the project", async () => {
    const owner = await testDb.user.create({ data: { name: "Owner" } });
    const member = await testDb.user.create({ data: { name: "Member" } });
    const { traceId } = await seedTrace(owner.id);
    await testDb.projectMembership.create({
      data: { projectId: "p-trace", userId: member.id, role: "EDITOR" },
    });

    const { markdown } = await getTraceMarkdownForActor(
      testDb,
      { userId: member.id, via: "token" },
      { traceId },
    );

    expect(markdown).toContain("# Test System — Trace: Auth → DB");
  });

  // A VIEWER member reads too — a Trace read needs only `view`.
  it("renders a Trace for a VIEWER member of the project", async () => {
    const owner = await testDb.user.create({ data: { name: "Owner" } });
    const member = await testDb.user.create({ data: { name: "Member" } });
    const { traceId } = await seedTrace(owner.id);
    await testDb.projectMembership.create({
      data: { projectId: "p-trace", userId: member.id, role: "VIEWER" },
    });

    const { markdown } = await getTraceMarkdownForActor(
      testDb,
      { userId: member.id, via: "token" },
      { traceId },
    );

    expect(markdown).toContain("# Test System — Trace: Auth → DB");
  });

  // Q1 pin: `guestAccess=VIEW` does NOT grant a non-member token actor — the
  // token path forces `guestAccess` to NONE, so a public-readable project's
  // Trace is still not-found to a stranger token (#109).
  it("does NOT grant a non-member token actor a Trace via guestAccess=VIEW", async () => {
    const owner = await testDb.user.create({ data: { name: "Owner" } });
    const intruder = await testDb.user.create({ data: { name: "Intruder" } });
    const { traceId } = await seedTrace(owner.id);
    await testDb.project.update({
      where: { id: "p-trace" },
      data: { guestAccess: "VIEW" },
    });

    await expect(
      getTraceMarkdownForActor(
        testDb,
        { userId: intruder.id, via: "token" },
        { traceId },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reports a soft-deleted Trace as not-found", async () => {
    const owner = await testDb.user.create({ data: { name: "Owner" } });
    const { traceId } = await seedTrace(owner.id);
    await testDb.trace.update({
      where: { id: traceId },
      data: { deletedAt: new Date() },
    });

    await expect(
      getTraceMarkdownForActor(
        testDb,
        { userId: owner.id, via: "token" },
        { traceId },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reports a Trace under a soft-deleted Project as not-found", async () => {
    const owner = await testDb.user.create({ data: { name: "Owner" } });
    const { traceId } = await seedTrace(owner.id);
    await testDb.project.update({
      where: { id: "p-trace" },
      data: { deletedAt: new Date() },
    });

    await expect(
      getTraceMarkdownForActor(
        testDb,
        { userId: owner.id, via: "token" },
        { traceId },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reports an unknown traceId as not-found", async () => {
    const owner = await testDb.user.create({ data: { name: "Owner" } });

    await expect(
      getTraceMarkdownForActor(
        testDb,
        { userId: owner.id, via: "token" },
        { traceId: "does-not-exist" },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("returns valid markdown with an insufficient-points note when < 2 live points remain", async () => {
    const owner = await testDb.user.create({ data: { name: "Owner" } });
    const { traceId, usersNodeId } = await seedTrace(owner.id);
    // Soft-delete one endpoint out from under an otherwise-valid owned Trace.
    await testDb.node.update({
      where: { id: usersNodeId },
      data: { deletedAt: new Date() },
    });

    const actor: Actor = { userId: owner.id, via: "token" };
    const { markdown } = await getTraceMarkdownForActor(testDb, actor, {
      traceId,
    });

    expect(markdown).toContain("# Test System — Trace: Auth → DB");
    expect(markdown).toContain("Fewer than two live trace points");
  });
});

/**
 * A host project that EMBEDS a foreign project (a portal) and draws a
 * cross-project Connection into it. The single user owns both, so they can read
 * the foreign content; the foreign Component documentation carries a SENTINEL
 * string so a test can assert it is NEVER inlined into the host export.
 */
async function seedHostWithCrossProjectMarkers() {
  const owner = await testDb.user.create({ data: { name: "Owner" } });
  const actor: Actor = { userId: owner.id, via: "session" };
  const host = await createProject(testDb, { userId: owner.id }, { title: "Host" });
  const foreign = await createProject(
    testDb,
    { userId: owner.id },
    { title: "Foreign System" },
  );

  const hostNode = await createNode(testDb, actor, {
    projectId: host.id,
    title: "Host Component",
  });
  const foreignNode = await createNode(testDb, actor, {
    projectId: foreign.id,
    title: "Foreign Endpoint",
    documentation: "SECRET_FOREIGN_DOCS should never be inlined into the host.",
  });
  // The portal's HOST-side title is deliberately DISTINCT from the foreign
  // project's title, so a non-disclosure assertion can check the foreign project
  // title ("Foreign System") never appears for an unreadable reader without
  // colliding with this host-owned node title.
  const portal = await createEmbeddedComponent(testDb, actor, {
    projectId: host.id,
    embeddedProjectId: foreign.id,
    title: "Portal To Foreign",
  });
  const edge = await connectCrossProject(testDb, actor, {
    hostProjectId: host.id,
    hostNodeId: hostNode.id,
    referenceNodeId: portal.id,
    foreignNodeId: foreignNode.id,
    interaction: "REQUEST",
  });

  return { owner, actor, host, foreign, hostNode, foreignNode, portal, edge };
}

describe("exportMarkdown cross-project reference markers (#123)", () => {
  it("emits a portal marker + a cross-project connection marker (foreign TITLE only, NOT inlined docs)", async () => {
    const { actor, host, foreign } = await seedHostWithCrossProjectMarkers();

    const { markdown } = await exportMarkdown(testDb, actor, {
      slug: host.slug,
      canvasNodeId: null,
      mode: "full",
    });

    // Section + non-recursive markers present.
    expect(markdown).toContain("## Cross-project references");
    expect(markdown).toContain("### Embedded projects");
    expect(markdown).toContain(
      "Portal To Foreign → **Foreign System** _(embedded project, not expanded)_",
    );
    expect(markdown).toContain("### Cross-project connections");
    expect(markdown).toContain(
      "Host Component → [Foreign System] Foreign Endpoint _(reference, not expanded)_",
    );

    // CRITICAL: the foreign Component's DOCUMENTATION is never inlined — markers
    // are references, not expansions (the per-actor firewall, ADR-0041/0044).
    expect(markdown).not.toContain("SECRET_FOREIGN_DOCS");
    // Foreign slug never on the export either — markers name foreign TITLE only.
    expect(markdown).not.toContain(foreign.slug);
  });

  it("omits the cross-project markers entirely for an actor who cannot read the foreign project", async () => {
    const { host, foreign } = await seedHostWithCrossProjectMarkers();
    // Close the foreign project and export as a DIFFERENT actor who has host view
    // (host stays guestAccess=VIEW by default) but no foreign grant.
    await testDb.project.update({
      where: { id: foreign.id },
      data: { guestAccess: "NONE" },
    });
    const stranger = await testDb.user.create({ data: { name: "Stranger" } });
    const strangerActor: Actor = { userId: stranger.id, via: "session" };

    const { markdown } = await exportMarkdown(testDb, strangerActor, {
      slug: host.slug,
      canvasNodeId: null,
      mode: "full",
    });

    // The host portal + cross edge exist, but the reader has no foreign grant, so
    // the firewall drops every marker — the foreign title never reaches the wire.
    expect(markdown).not.toContain("## Cross-project references");
    expect(markdown).not.toContain("Foreign System");
    expect(markdown).not.toContain("Foreign Endpoint");
    expect(markdown).not.toContain("SECRET_FOREIGN_DOCS");
  });

  it("DOES emit cross-project markers for an anonymous export when the foreign is genuinely PUBLIC (guestAccess=VIEW)", async () => {
    const { host, foreign } = await seedHostWithCrossProjectMarkers();
    // Make the foreign project's public-readability explicit (it defaults to VIEW,
    // but pin it so the positive direction can't be silenced by a default change).
    await testDb.project.update({
      where: { id: foreign.id },
      data: { guestAccess: "VIEW" },
    });

    // Anonymous reader (actor null): a genuinely public foreign grants the guest
    // read, so the firewall KEEPS the markers — the foreign title surfaces. This
    // guards against a future over-tightening that silently drops ALL anonymous
    // markers (the zero-marker tests cover only the security direction).
    const { markdown } = await exportMarkdown(testDb, null, {
      slug: host.slug,
      canvasNodeId: null,
      mode: "full",
    });

    expect(markdown).toContain("## Cross-project references");
    expect(markdown).toContain(
      "Portal To Foreign → **Foreign System** _(embedded project, not expanded)_",
    );
    expect(markdown).toContain(
      "Host Component → [Foreign System] Foreign Endpoint _(reference, not expanded)_",
    );
    // Still a reference, never an expansion — foreign docs never inline.
    expect(markdown).not.toContain("SECRET_FOREIGN_DOCS");
  });

  it("emits zero cross-project markers for an anonymous export when the foreign holds no guest grant", async () => {
    const { host, foreign } = await seedHostWithCrossProjectMarkers();
    // Close the foreign project: an anonymous reader holds no membership and no
    // guest grant, so the firewall drops every cross-project marker (the headline
    // non-disclosure invariant — same posture getCanvas takes).
    await testDb.project.update({
      where: { id: foreign.id },
      data: { guestAccess: "NONE" },
    });

    const { markdown } = await exportMarkdown(testDb, null, {
      slug: host.slug,
      canvasNodeId: null,
      mode: "full",
    });

    expect(markdown).not.toContain("## Cross-project references");
    expect(markdown).not.toContain("Foreign Endpoint");
    expect(markdown).not.toContain("SECRET_FOREIGN_DOCS");
  });
});
