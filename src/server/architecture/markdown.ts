import type { Heading } from "mdast";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import { arrowEnds } from "~/lib/connection-direction";
import { type Interaction } from "~/lib/schemas";
import { type NodeKind as PrismaNodeKind } from "../../../generated/prisma/client";

/**
 * Pure deterministic markdown serializer (M2 / #15; ADR-0017 + #67 amendment).
 * Takes already-fetched, already-authorized graph data and returns a
 * byte-stable string. No `db`, no authorization, no I/O: this is the unit the
 * MCP read path (#18) reuses behind a token gate.
 *
 * Determinism contract (every clause is load-bearing; see ADR-0017):
 *
 *  - Ordering is computed here in application code with a Unicode codepoint
 *    comparator, never delegated to SQL (Postgres `ORDER BY` is collation-
 *    aware and locale-sensitive) and never via `String#localeCompare` / `Intl`
 *    (the only locale-sensitive JS primitives). Sorting in JS with `<`/`>` is
 *    codepoint-stable, so locale-invariance holds by construction.
 *  - No timestamps appear in the output.
 *  - Authored Component documentation is heading-shifted via an mdast AST
 *    walk (`unist-util-visit`), never via regex (the issue mandate). The
 *    `remark-stringify` options are pinned explicitly below so a remark
 *    version bump cannot silently re-baseline the golden fixtures.
 *
 * Typed cross-scope rewrite (#67):
 *
 *  - Each Connection serializes exactly once at its real `(source, target)`
 *    endpoints, NEVER mirrored under altitude reprs (an LLM counting
 *    Connections from the markdown must not over-count). The multi-altitude
 *    canvas projection (`sourceRepr`/`targetRepr` from `getCanvas`,
 *    ADR-0031) is presentation-only and stays out of this module.
 *  - The interaction glyph is derived from `arrowEnds(interaction)` (the
 *    `~/lib/connection-direction` helper, ADR-0027) — booleans are the
 *    canonical mapping, two consumers (the canvas marker mapping in the
 *    island, the glyph below) translate them to their rendering language.
 *  - Sort key: `(sourceId, targetId, interaction, id)`. `interaction` is in
 *    the directional de-dupe key (ADR-0010 amendment + ADR-0027), so it
 *    enters the sort to keep the order total; `id` stays as paranoia
 *    tiebreak.
 *  - The subtree Boundary section lists one row per crossing Connection
 *    (not coalesced by far Node), each naming the far endpoint with its
 *    anchor — matching ADR-0031's per-edge posture on the export consumer.
 *    The `direct/inherited` partition is retired with the Flow model.
 *  - Generated Components (#64 / ADR-0029) require no special arm — they are
 *    ordinary Nodes that serialize through `renderComponentsFull` /
 *    `renderComponentsIndex`. Anchors stay stable across re-parse because
 *    `parseSpecDiff` preserves `Node.id` on matched `specKey`.
 */

export interface SerializerProject {
  title: string;
}

export interface SerializerNode {
  id: string;
  parentId: string | null;
  title: string;
  kind: PrismaNodeKind;
  documentation: string;
}

export interface SerializerEdge {
  id: string;
  sourceId: string;
  targetId: string;
  interaction: Interaction;
  label: string | null;
}

/**
 * One boundary-crossing Connection as seen from inside a subtree export. Each
 * row carries the full Connection (so the renderer emits the same shape it
 * uses inside the Components Connection list) PLUS the denormalized far-end
 * Component fields the pure serializer cannot fetch. ADR-0031 settles the
 * per-edge posture (one row per crossing Edge, no `direct/inherited`
 * partition); #67 adopts it on the export consumer. The export's subtree
 * derivation stays intentionally separate from `getCanvas`'s whole-Project
 * ancestry walk (ADR-0031 §"Scope of this ADR" — two consumers, two
 * derivations, no DRY).
 */
export interface SerializerBoundaryEdge {
  edgeId: string;
  sourceId: string;
  targetId: string;
  interaction: Interaction;
  label: string | null;
  // The far endpoint — the Node outside the exported subtree. Denormalized so
  // the renderer can emit a Connection-shaped line `near → far {#far-id}`
  // without reaching for the DB.
  farEndpointId: string;
  farTitle: string;
  farKind: PrismaNodeKind;
}

export type SerializerMode = "full" | "index";

export interface SerializerInput {
  project: SerializerProject;
  // The scope being exported. `null` = the whole Project (no Boundary
  // section: the root has no ancestors). A Node id = the subtree rooted at
  // that Component (Boundary section enumerates one row per Connection that
  // crosses the subtree boundary, far endpoint named, so the export is
  // self-describing).
  rootCanvasNodeId: string | null;
  nodes: SerializerNode[];
  edges: SerializerEdge[];
  boundaryEdges: SerializerBoundaryEdge[];
  mode: SerializerMode;
}

// User-facing kind labels (CONTEXT.md "Component kind"). The enum identifiers
// are code surface; never leak them into rendered output. A deliberate
// server-side copy keyed by `PrismaNodeKind` — the client catalog
// (`~/lib/node-kinds`) carries the same labels but pulls in `lucide-react`, which
// must never reach this pure serializer module (ADR-0017). The exhaustive
// `Record<PrismaNodeKind, string>` forces a new kind to be labelled here too, so
// the two maps cannot silently drift in coverage.
const KIND_LABEL: Record<PrismaNodeKind, string> = {
  GENERIC: "Generic",
  GLOBAL_INFRA: "Global infrastructure",
  REGION: "Region",
  DATACENTER: "Data center",
  NETWORK: "Network",
  HOST: "Host",
  CONTAINER: "Container",
  SERVICE: "Service",
  MICROSERVICE: "Microservice",
  CRON: "Cron",
  QUEUE: "Queue",
  APPLICATION: "Application",
  MODULE: "Module",
  CLASS: "Class",
  FUNCTION: "Function",
  VARIABLE: "Variable",
  BRANCH: "Branch",
  DATABASE: "Database",
  TABLE: "Table",
  STORED_PROCEDURE: "Stored procedure",
  EXTERNAL_API: "External API",
  ENDPOINT: "Endpoint",
  WEBHOOK: "Webhook",
  TOPIC: "Topic",
  CONSUMER: "Consumer",
  PRODUCER: "Producer",
};

/**
 * Codepoint comparator. JS string `<`/`>` compare UTF-16 code unit by code
 * unit, which is locale-free and stable. NEVER use `localeCompare` / `Intl`
 * here — those are exactly the primitives the locale-invariance test would
 * catch (ADR-0017).
 */
function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Renders an {@link Interaction} as the glyph that bridges the two endpoints
 * of a Connection line. Derived from `arrowEnds()` (the canonical mapping in
 * `~/lib/connection-direction`, ADR-0027) so the markdown exporter and the
 * canvas marker renderer (in the Canvas island) share one source of truth for
 * "which ends bear an arrow." The exporter translates those booleans into
 * a glyph; the canvas translates them into React Flow `markerStart`/
 * `markerEnd`. Keeping the glyph mapping here (not in `~/lib`) preserves the
 * "one mapping, two consumers" framing: `~/lib` returns booleans; each
 * consumer chooses its rendering language.
 *
 *   {F,F} → `—` (ASSOCIATION — plain undirected line)
 *   {F,T} → `→` (REQUEST / PUSH — arrow at target)
 *   {T,F} → `←` (SUBSCRIBE — arrow at source)
 *   {T,T} → `↔` (DUPLEX — arrows at both ends)
 */
function interactionGlyph(interaction: Interaction): string {
  const { atSource, atTarget } = arrowEnds(interaction);
  if (atSource && atTarget) return "↔";
  if (atTarget) return "→";
  if (atSource) return "←";
  return "—";
}

/**
 * Builds an mdast → markdown processor with options pinned so a remark
 * version bump cannot silently change byte output. The pins matter because
 * the golden file is byte-equal — `bullet`, `emphasis`, `strong`, `rule`,
 * `fences`, `setext` each have library-default values that could flip across
 * versions. Constructed once at module load (processors are reusable).
 */
const mdProcessor = unified().use(remarkParse).use(remarkStringify, {
  bullet: "-",
  bulletOther: "*",
  emphasis: "_",
  strong: "*",
  listItemIndent: "one",
  rule: "-",
  ruleSpaces: false,
  fences: true,
  setext: false,
  tightDefinitions: true,
});

/**
 * Shifts every heading depth in an authored markdown string by `by`, clamped
 * at the mdast maximum (6). AST walk via `unist-util-visit` — never regex,
 * never string manipulation (issue #15 mandate).
 *
 * Round-trip canonicalizes formatting (setext → ATX, `*`/`+` bullets → `-`,
 * etc.) — acceptable and arguably desirable for stable LLM input.
 */
function shiftHeadings(markdown: string, by: number): string {
  if (markdown.length === 0) return "";
  const ast = mdProcessor.parse(markdown);
  visit(ast, "heading", (heading: Heading) => {
    const shifted = Math.min(6, heading.depth + by);
    heading.depth = shifted as Heading["depth"];
  });
  return mdProcessor.stringify(ast);
}

/**
 * Computes each Node's path (root → … → self) and its depth (0 at the
 * export root) by walking `parentId` up to either the export root (a
 * subtree's `rootCanvasNodeId`) or the project root (null). Done once,
 * memoised by `nodeId`, so the ordering pass and the per-Component renderer
 * share the same numbers.
 */
function buildPaths(
  nodes: SerializerNode[],
  rootCanvasNodeId: string | null,
): Map<string, { titles: string[]; depth: number }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const result = new Map<string, { titles: string[]; depth: number }>();

  function compute(nodeId: string): { titles: string[]; depth: number } {
    const cached = result.get(nodeId);
    if (cached) return cached;
    const node = byId.get(nodeId);
    if (!node) {
      const entry = { titles: [], depth: 0 };
      result.set(nodeId, entry);
      return entry;
    }
    if (node.id === rootCanvasNodeId || node.parentId === null) {
      const entry = { titles: [node.title], depth: 0 };
      result.set(nodeId, entry);
      return entry;
    }
    const parent = compute(node.parentId);
    const entry = {
      titles: [...parent.titles, node.title],
      depth: parent.depth + 1,
    };
    result.set(nodeId, entry);
    return entry;
  }

  for (const n of nodes) compute(n.id);
  return result;
}

/**
 * Renders a `path:` line for a Component, e.g. `Auth Service → Users Module`.
 * Uses `→` (U+2192), a fixed Unicode character — no locale-dependent
 * formatting.
 */
function renderPath(titles: string[]): string {
  return titles.join(" → ");
}

/** Count of Connections incident to this Component (either endpoint). */
function countIncident(nodeId: string, edges: SerializerEdge[]): number {
  let n = 0;
  for (const e of edges) {
    if (e.sourceId === nodeId || e.targetId === nodeId) n += 1;
  }
  return n;
}

/** Render the export-header summary line. */
function renderSummary(nodeCount: number, edgeCount: number): string {
  const c = `${nodeCount} ${nodeCount === 1 ? "Component" : "Components"}`;
  const e = `${edgeCount} ${edgeCount === 1 ? "Connection" : "Connections"}`;
  return `> ${c} · ${e}`;
}

function renderHeader(input: SerializerInput): string {
  const title = input.project.title;
  const indexSuffix = input.mode === "index" ? " — Index" : "";
  const lines = [`# ${title}${indexSuffix}`, ""];
  if (input.rootCanvasNodeId !== null) {
    const root = input.nodes.find((n) => n.id === input.rootCanvasNodeId);
    const rootTitle = root?.title ?? input.rootCanvasNodeId;
    lines.push(`> Subtree of **${rootTitle}**`);
  }
  lines.push(renderSummary(input.nodes.length, input.edges.length));
  lines.push("");
  return lines.join("\n");
}

function renderBoundary(input: SerializerInput): string {
  if (input.boundaryEdges.length === 0) return "";
  // One row per crossing Connection (ADR-0031 per-edge posture extended to
  // the export consumer). Sort key mirrors the Connections section so the two
  // lists read with the same shape: `(sourceId, targetId, interaction,
  // edgeId)`. No `direct/inherited` partition.
  const sorted = [...input.boundaryEdges].sort(
    (a, b) =>
      cmp(a.sourceId, b.sourceId) ||
      cmp(a.targetId, b.targetId) ||
      cmp(a.interaction, b.interaction) ||
      cmp(a.edgeId, b.edgeId),
  );
  const interiorById = new Map(input.nodes.map((n) => [n.id, n]));
  const lines = ["## Boundary context", ""];
  for (const edge of sorted) {
    const sourceIsInterior = interiorById.has(edge.sourceId);
    const sourceTitle = sourceIsInterior
      ? interiorById.get(edge.sourceId)!.title
      : edge.farTitle;
    const targetTitle = sourceIsInterior
      ? edge.farTitle
      : interiorById.get(edge.targetId)!.title;
    const farKindSuffix = ` (${KIND_LABEL[edge.farKind]})`;
    const glyph = interactionGlyph(edge.interaction);
    const labelPart = edge.label ? ` · ${edge.label}` : "";
    lines.push(
      `- ${sourceTitle} {#${edge.sourceId}} ${glyph} ${targetTitle} {#${edge.targetId}}${farKindSuffix}${labelPart}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderComponentsFull(
  input: SerializerInput,
  paths: Map<string, { titles: string[]; depth: number }>,
): string {
  // Global order: depth ASC, title ASC (codepoint), id ASC (codepoint).
  const ordered = [...input.nodes].sort((a, b) => {
    const pa = paths.get(a.id)!;
    const pb = paths.get(b.id)!;
    return pa.depth - pb.depth || cmp(a.title, b.title) || cmp(a.id, b.id);
  });
  const lines = ["## Components", ""];
  for (const node of ordered) {
    const p = paths.get(node.id)!;
    lines.push(`### ${node.title} {#${node.id}}`);
    lines.push(`- kind: ${KIND_LABEL[node.kind]}`);
    lines.push(`- path: ${renderPath(p.titles)}`);
    lines.push("");
    const docs = shiftHeadings(node.documentation, 3);
    if (docs.length > 0) {
      // `remark-stringify` already ends with a trailing newline; normalise to
      // a single trailing blank line so the next `###` section starts clean.
      lines.push(docs.trimEnd());
      lines.push("");
    }
  }
  return lines.join("\n");
}

function renderComponentsIndex(
  input: SerializerInput,
  paths: Map<string, { titles: string[]; depth: number }>,
): string {
  const ordered = [...input.nodes].sort((a, b) => {
    const pa = paths.get(a.id)!;
    const pb = paths.get(b.id)!;
    return pa.depth - pb.depth || cmp(a.title, b.title) || cmp(a.id, b.id);
  });
  const lines = ["## Components", ""];
  for (const node of ordered) {
    const p = paths.get(node.id)!;
    const indent = "  ".repeat(p.depth);
    const incident = countIncident(node.id, input.edges);
    const label = `${incident} ${incident === 1 ? "connection" : "connections"}`;
    lines.push(
      `${indent}- **${node.title}** {#${node.id}} — ${KIND_LABEL[node.kind]} · ${label}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function renderConnections(input: SerializerInput): string {
  if (input.edges.length === 0) return "";
  const byId = new Map(input.nodes.map((n) => [n.id, n]));

  // Stable order: (sourceId, targetId, interaction, edgeId). `interaction`
  // enters the key because the directional de-dupe (ADR-0010 amendment +
  // ADR-0027) admits `A→B REQUEST` and `A→B PUSH` as distinct active
  // Connections; without it, two such rows would tiebreak only by opaque
  // cuid. The `edgeId` tail keeps the byte output stable across any future
  // shape change.
  const ordered = [...input.edges].sort(
    (a, b) =>
      cmp(a.sourceId, b.sourceId) ||
      cmp(a.targetId, b.targetId) ||
      cmp(a.interaction, b.interaction) ||
      cmp(a.id, b.id),
  );

  const lines = ["## Connections", ""];
  for (const e of ordered) {
    const source = byId.get(e.sourceId);
    const target = byId.get(e.targetId);
    const sTitle = source?.title ?? e.sourceId;
    const tTitle = target?.title ?? e.targetId;
    const glyph = interactionGlyph(e.interaction);
    // Label separator is ` · ` (mid-dot, U+00B7) — distinct from the
    // ASSOCIATION glyph `—` (em-dash). Mid-dot is already in-vocabulary in
    // the export header (`> N Components · M Connections`).
    const labelPart = e.label ? ` · ${e.label}` : "";
    lines.push(
      `- ${sTitle} {#${e.sourceId}} ${glyph} ${tTitle} {#${e.targetId}}${labelPart}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Render the graph to deterministic markdown. The output is a single string,
 * always ending in a single trailing newline so concatenations and file
 * writers behave predictably.
 */
export function serializeGraph(input: SerializerInput): string {
  const paths = buildPaths(input.nodes, input.rootCanvasNodeId);
  const parts: string[] = [];
  parts.push(renderHeader(input));
  const boundary = renderBoundary(input);
  if (boundary.length > 0) parts.push(boundary);
  parts.push(
    input.mode === "index"
      ? renderComponentsIndex(input, paths)
      : renderComponentsFull(input, paths),
  );
  if (input.mode === "full") {
    const connections = renderConnections(input);
    if (connections.length > 0) parts.push(connections);
  }
  // Single trailing newline; never double-newline at EOF.
  return parts.join("\n").replace(/\n+$/, "") + "\n";
}
