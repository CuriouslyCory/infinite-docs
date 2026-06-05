import { randomUUID } from "node:crypto";

import {
  createTraceInput,
  deleteTraceInput,
  getTraceInput,
  getTraceViewInput,
  listTracesInput,
  mcpTraceReadInput,
  renameTraceInput,
  type CreateTraceInput,
  type DeleteTraceInput,
  type GetTraceInput,
  type GetTraceViewInput,
  type Interaction,
  type ListTracesInput,
  type McpTraceReadInput,
  type NodeKind,
  type RenameTraceInput,
} from "~/lib/schemas";
import type { Actor, Db } from "./actor";
import { capabilityAtLeast, resolveCapability } from "./access";
import {
  resolveReadableProject,
  resolveWritableProjectBySlug,
} from "./access-db";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { serializeTrace, type SerializerNode } from "./markdown";
import { isTraceNameCollision } from "./prisma-errors";

/**
 * The cross-layer **Trace view** derivation (#58). Given a working trace of 2+
 * **trace points**, computes the read-only **Trace subgraph**: every Component
 * and Connection lying on a path between some pair of trace points, expanded
 * across all layers at once, plus each Component's nesting ancestors so the
 * client can render it inside its boxes.
 *
 * The Trace is NEVER stored as a subgraph — only the point set is selection
 * state (#57; #59 persists it). The on-path union is recomputed on every read
 * over the unified undirected graph and capped at `TRACE_NODE_CAP` Components
 * with a surfaced truncation warning (ADR-0034).
 */

/**
 * Maximum Components in a derived Trace subgraph. A backstop against a dense
 * graph blowing up the render — NOT the correctness argument (the block-cut-tree
 * derivation is exact and terminating). On overflow the service TRUNCATES the
 * node set deterministically and surfaces a warning; it never hangs or throws
 * (distinct from `getCanvas`'s depth-cap throw — here truncation is a normal,
 * user-visible outcome, ADR-0034).
 */
export const TRACE_NODE_CAP = 500;

// Belt-and-suspenders against a cycle in the `parentId` chain (prevention is
// `moveNode`'s job, ADR-0024) and a real nesting-depth ceiling — mirrors
// `node.service.ts`'s `ANCESTRY_DEPTH_CAP`, applied here to the in-memory climb.
const ANCESTRY_DEPTH_CAP = 256;

export interface TraceViewNode {
  id: string;
  title: string;
  kind: NodeKind;
  parentId: string | null;
  /** The Component's markdown docs, so the read-only detail panel renders with
   *  no click-time round trip (perf philosophy #1). Bounded by the node cap. */
  documentation: string;
  /** True when this node is itself a valid, on-path trace point — lets the
   *  client highlight the endpoints distinctly from path-only intermediaries
   *  and ancestor-only container boxes. */
  isTracePoint: boolean;
}

export interface TraceViewEdge {
  id: string;
  sourceId: string;
  targetId: string;
  interaction: Interaction;
  label: string | null;
}

export interface TraceView {
  nodes: TraceViewNode[];
  edges: TraceViewEdge[];
  tracePointIds: string[];
  truncated: boolean;
  warning: string | null;
}

interface RawNode {
  id: string;
  title: string;
  kind: NodeKind;
  parentId: string | null;
  documentation: string;
}

interface RawEdge {
  id: string;
  sourceId: string;
  targetId: string;
  interaction: Interaction;
  label: string | null;
}

const EMPTY_TRACE = (tracePointIds: string[]): TraceView => ({
  nodes: [],
  edges: [],
  tracePointIds,
  truncated: false,
  warning: null,
});

/**
 * One undirected edge of the unified graph, carrying the Edge id it came from so
 * the on-path walk can collect Connection ids (a nesting link has `edgeId: null`
 * — it is structural, not a Connection).
 */
interface UndirectedLink {
  a: string;
  b: string;
  edgeId: string | null;
}

interface UnifiedGraph {
  /** adjacency: node id -> indices into `links` incident to it. */
  adj: Map<string, number[]>;
  links: UndirectedLink[];
}

/**
 * Builds the unified undirected graph: the edge set is exactly active
 * Connections ∪ parent↔child nesting links. There is NO third "FlowRoute inner
 * edge" class — the Flow model and its inner-Edge writer were retired in #62
 * (ADR-0030), so a cross-scope Connection is just an ordinary Edge whose
 * endpoints have different `parentId` ancestry and is already in the Edge set
 * (ADR-0034). A Connection whose endpoint is not a live node in this Project is
 * dropped (the node set is the live universe).
 */
export function buildUnifiedGraph(
  nodes: RawNode[],
  edges: RawEdge[],
): UnifiedGraph {
  const live = new Set(nodes.map((n) => n.id));
  const links: UndirectedLink[] = [];
  const adj = new Map<string, number[]>();

  const addLink = (a: string, b: string, edgeId: string | null) => {
    if (a === b) return;
    const index = links.length;
    links.push({ a, b, edgeId });
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(index);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(index);
  };

  for (const node of nodes) {
    adj.set(node.id, adj.get(node.id) ?? []);
    if (node.parentId !== null && live.has(node.parentId)) {
      addLink(node.id, node.parentId, null);
    }
  }
  for (const edge of edges) {
    if (live.has(edge.sourceId) && live.has(edge.targetId)) {
      addLink(edge.sourceId, edge.targetId, edge.id);
    }
  }

  return { adj, links };
}

/**
 * Iterative Tarjan biconnected-component decomposition over the unified graph.
 * Returns, per link index, the id of the biconnected component (block) it
 * belongs to, plus the set of cut vertices. Iterative (explicit stacks) rather
 * than recursive so a deep graph at the node cap cannot overflow the call stack.
 *
 * This underpins the on-path characterization: a vertex lies on SOME simple path
 * between A and B iff it sits on the A–B path of the block-cut tree. Enumerating
 * simple paths directly is NP-hard; the block-cut decomposition gives the exact
 * same vertex/edge set in O(V+E) and always terminates (ADR-0034, risk #1).
 */
export function biconnectedComponents(graph: UnifiedGraph): {
  blockOfLink: number[];
  linksInBlock: Map<number, number[]>;
} {
  const { adj, links } = graph;
  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const blockOfLink = new Array<number>(links.length).fill(-1);
  const linksInBlock = new Map<number, number[]>();

  let timer = 0;
  let blockId = 0;
  const edgeStack: number[] = [];

  // Pop the edge stack down to and including the tree edge `(parent, child)` that
  // closed an articulation point; those edges form one biconnected block.
  const assignBlock = (untilLink: number) => {
    const id = blockId++;
    const collected: number[] = [];
    while (edgeStack.length > 0) {
      const e = edgeStack.pop()!;
      blockOfLink[e] = id;
      collected.push(e);
      if (e === untilLink) break;
    }
    linksInBlock.set(id, collected);
  };

  for (const start of adj.keys()) {
    if (disc.has(start)) continue;

    // Each frame: the node, its parent link index (-1 at the root), and the
    // pointer into its incidence list (resumable, the iterative DFS state).
    const frames: { node: string; parentLink: number; next: number }[] = [
      { node: start, parentLink: -1, next: 0 },
    ];
    disc.set(start, timer);
    low.set(start, timer);
    timer++;

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const incident = adj.get(frame.node)!;

      if (frame.next < incident.length) {
        const linkIndex = incident[frame.next]!;
        frame.next++;
        if (linkIndex === frame.parentLink) continue;

        const link = links[linkIndex]!;
        const neighbor = link.a === frame.node ? link.b : link.a;

        if (!disc.has(neighbor)) {
          edgeStack.push(linkIndex);
          disc.set(neighbor, timer);
          low.set(neighbor, timer);
          timer++;
          frames.push({ node: neighbor, parentLink: linkIndex, next: 0 });
        } else if (disc.get(neighbor)! < disc.get(frame.node)!) {
          // Back edge to an ancestor — part of the current block.
          edgeStack.push(linkIndex);
          low.set(
            frame.node,
            Math.min(low.get(frame.node)!, disc.get(neighbor)!),
          );
        }
      } else {
        // Done exploring this node; fold its low-link into its parent and cut a
        // block whenever the parent is an articulation point for this subtree.
        frames.pop();
        const parent = frames[frames.length - 1];
        if (parent) {
          low.set(
            parent.node,
            Math.min(low.get(parent.node)!, low.get(frame.node)!),
          );
          if (low.get(frame.node)! >= disc.get(parent.node)!) {
            assignBlock(frame.parentLink);
          }
        }
      }
    }
  }

  return { blockOfLink, linksInBlock };
}

/**
 * Block-cut tree over the biconnected decomposition. Nodes of the tree are
 * blocks (`B:<blockId>`) and cut/articulation vertices (`V:<nodeId>`); a block
 * is joined to each distinct vertex it contains. The on-path set for a pair is
 * the union of all blocks on the unique tree path between the two endpoints'
 * blocks — which we resolve by a BFS over this tree (ADR-0034).
 */
function buildBlockCutTree(graph: UnifiedGraph): {
  treeAdj: Map<string, Set<string>>;
  blocksOfVertex: Map<string, Set<number>>;
  verticesOfBlock: Map<number, Set<string>>;
} {
  const { linksInBlock } = biconnectedComponents(graph);
  const treeAdj = new Map<string, Set<string>>();
  const blocksOfVertex = new Map<string, Set<number>>();
  const verticesOfBlock = new Map<number, Set<string>>();

  const join = (x: string, y: string) => {
    (treeAdj.get(x) ?? treeAdj.set(x, new Set()).get(x)!).add(y);
    (treeAdj.get(y) ?? treeAdj.set(y, new Set()).get(y)!).add(x);
  };

  for (const [blockId, linkIndices] of linksInBlock) {
    const blockKey = `B:${blockId}`;
    const vertices = new Set<string>();
    for (const linkIndex of linkIndices) {
      const link = graph.links[linkIndex]!;
      vertices.add(link.a);
      vertices.add(link.b);
    }
    verticesOfBlock.set(blockId, vertices);
    for (const v of vertices) {
      (blocksOfVertex.get(v) ?? blocksOfVertex.set(v, new Set()).get(v)!).add(
        blockId,
      );
      join(blockKey, `V:${v}`);
    }
  }

  return { treeAdj, blocksOfVertex, verticesOfBlock };
}

/**
 * The on-path union for the whole trace: for every unordered pair of valid trace
 * points, collect every node and Connection id on SOME simple path between them
 * (the block-cut-tree path's blocks), then union across all pairs. Disconnected
 * pairs (no tree path) contribute nothing; a self-pair is skipped.
 */
export function onPathUnion(
  graph: UnifiedGraph,
  validPoints: string[],
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const { treeAdj, blocksOfVertex, verticesOfBlock } = buildBlockCutTree(graph);
  const nodeIds = new Set<string>();

  // Resolve the block-cut-tree path between each pair's vertices and union the
  // blocks it traverses (each block contributes all its vertices). BFS over the
  // small block-cut tree per pair; a disconnected pair yields no blocks.
  for (let i = 0; i < validPoints.length; i++) {
    for (let j = i + 1; j < validPoints.length; j++) {
      const pathBlocks = blockCutPathBlocks(
        treeAdj,
        blocksOfVertex,
        validPoints[i]!,
        validPoints[j]!,
      );
      for (const blockId of pathBlocks) {
        for (const v of verticesOfBlock.get(blockId) ?? []) nodeIds.add(v);
      }
    }
  }

  // A Connection is on-path iff both its endpoints survived into the node set —
  // it then sits inside an included block (the block containing that link).
  return { nodeIds, edgeIds: collectEdgeIds(graph, nodeIds) };
}

/**
 * BFS the block-cut tree from `a` to `b` and return the block ids on the path.
 * Returns an empty set when `a` and `b` are in different components (no path) —
 * exactly the "disconnected pair contributes nothing" case.
 */
function blockCutPathBlocks(
  treeAdj: Map<string, Set<string>>,
  blocksOfVertex: Map<string, Set<number>>,
  a: string,
  b: string,
): Set<number> {
  const result = new Set<number>();
  if (a === b) return result;
  const startBlocks = blocksOfVertex.get(a);
  const endKey = `V:${b}`;
  if (!startBlocks || !blocksOfVertex.get(b)) return result;

  // BFS from the vertex node of `a` over the block-cut tree to the vertex node
  // of `b`, recording predecessors so we can walk the path back and pick the
  // block nodes on it.
  const startKey = `V:${a}`;
  const prev = new Map<string, string | null>();
  prev.set(startKey, null);
  const queue: string[] = [startKey];
  let found = false;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === endKey) {
      found = true;
      break;
    }
    for (const next of treeAdj.get(cur) ?? []) {
      if (!prev.has(next)) {
        prev.set(next, cur);
        queue.push(next);
      }
    }
  }
  if (!found) return result;

  let node: string | null = endKey;
  while (node !== null) {
    if (node.startsWith("B:")) {
      result.add(Number(node.slice(2)));
    }
    node = prev.get(node) ?? null;
  }
  return result;
}

/** Connection ids whose link sits in an included block (both endpoints on-path). */
function collectEdgeIds(
  graph: UnifiedGraph,
  nodeIds: Set<string>,
): Set<string> {
  const edgeIds = new Set<string>();
  for (const link of graph.links) {
    if (link.edgeId === null) continue;
    if (nodeIds.has(link.a) && nodeIds.has(link.b)) {
      edgeIds.add(link.edgeId);
    }
  }
  return edgeIds;
}

/**
 * Climbs `parentId` for every on-path node and adds the ancestors to the node
 * set, so each Component renders inside its nesting boxes. Pure, in-memory over
 * the already-fetched node map (no per-node query), bounded by
 * `ANCESTRY_DEPTH_CAP` against a `parentId`-cycle regression.
 */
export function addNestingAncestors(
  nodeIds: Set<string>,
  byId: Map<string, RawNode>,
): void {
  const seed = [...nodeIds];
  for (const id of seed) {
    let current = byId.get(id)?.parentId ?? null;
    let depth = 0;
    while (
      current !== null &&
      !nodeIds.has(current) &&
      depth < ANCESTRY_DEPTH_CAP
    ) {
      nodeIds.add(current);
      current = byId.get(current)?.parentId ?? null;
      depth++;
    }
  }
}

/**
 * The live node + Connection universe for a Project: both flat findManys on
 * indexed columns (no CTE needed). Shared by the slug-bound {@link getTraceView}
 * and the owner-gated {@link getTraceMarkdownForActor} so the two consumers
 * derive over byte-identical inputs (the on-path subgraph is recomputed, never
 * stored — ADR-0034). `projectId` is the already-resolved id; authorization is
 * the caller's responsibility (this helper is fetch-only).
 */
async function fetchProjectGraph(
  db: Db,
  projectId: string,
): Promise<{ nodes: RawNode[]; edges: RawEdge[] }> {
  const [nodes, edges] = await Promise.all([
    db.node.findMany({
      where: { projectId, deletedAt: null },
      select: {
        id: true,
        title: true,
        kind: true,
        parentId: true,
        documentation: true,
      },
    }) as Promise<RawNode[]>,
    db.edge.findMany({
      where: { projectId, deletedAt: null },
      select: {
        id: true,
        sourceId: true,
        targetId: true,
        interaction: true,
        label: true,
      },
    }) as Promise<RawEdge[]>,
  ]);
  return { nodes, edges };
}

/**
 * Enforce the `TRACE_NODE_CAP` on the on-path node set while keeping it
 * ancestor-closed. The kept set MUST stay ancestor-closed: the client layout
 * (`trace-layout.ts`) treats a node as a root when its `parentId` is absent from
 * the set, so a kept node whose ancestor was sliced away would be flattened out
 * of its boxes — a broken hierarchy. A naive `sort + slice` can also drop the
 * trace-point endpoints themselves, which then trips the <2 endpoints empty
 * state. So truncation keeps (1) the valid endpoints + their full ancestor
 * closure as mandatory, then (2) fills the remaining budget deterministically
 * (id order) with other on-path nodes, pulling each fill node's ancestor closure
 * in atomically and skipping it whole if it won't fit.
 *
 * Pure code-motion of what was inline in {@link getTraceView}; extracted so the
 * cap rule cannot drift between the in-app Trace view and the MCP markdown
 * (ADR-0034). `byId` is the live-node map; `validPoints` are the (already
 * filtered) live, in-Project trace-point ids.
 */
function capTraceNodes(
  onPathNodeIds: Set<string>,
  byId: Map<string, RawNode>,
  validPoints: string[],
): {
  kept: Set<string>;
  keptIds: string[];
  truncated: boolean;
  warning: string | null;
} {
  const ancestorClosure = (id: string): string[] => {
    const chain: string[] = [];
    let current: string | null = id;
    let depth = 0;
    while (current !== null && depth < ANCESTRY_DEPTH_CAP) {
      chain.push(current);
      current = byId.get(current)?.parentId ?? null;
      depth++;
    }
    return chain;
  };

  let truncated = false;
  let warning: string | null = null;
  const sortedOnPath = [...onPathNodeIds].sort();

  let kept: Set<string>;
  if (sortedOnPath.length <= TRACE_NODE_CAP) {
    kept = onPathNodeIds;
  } else {
    truncated = true;
    warning = `Showing the first ${TRACE_NODE_CAP} Components on these paths — refine your trace points to narrow it.`;

    // Mandatory: the valid endpoints and the full ancestor closure of each. If
    // even this exceeds the cap it is the genuine overflow — keep it (still
    // ancestor-closed) and surface the warning rather than silently dropping
    // endpoints.
    kept = new Set<string>();
    for (const point of [...validPoints].sort()) {
      for (const id of ancestorClosure(point)) kept.add(id);
    }

    // Fill the remaining budget deterministically, each fill node together with
    // its ancestor closure, so the set never gains a dangling parent.
    for (const id of sortedOnPath) {
      if (kept.size >= TRACE_NODE_CAP) break;
      if (kept.has(id)) continue;
      const closure = ancestorClosure(id);
      const additions = closure.filter((c) => !kept.has(c));
      if (kept.size + additions.length > TRACE_NODE_CAP) continue;
      for (const c of additions) kept.add(c);
    }
  }
  return { kept, keptIds: [...kept].sort(), truncated, warning };
}

export async function getTraceView(
  db: Db,
  actor: Actor | null,
  input: GetTraceViewInput,
): Promise<TraceView> {
  const { slug, nodeIds: requestedIds } = getTraceViewInput.parse(input);

  // Capability-gated on `view` via the slug→project bind (ADR-0040, parity with
  // `getCanvas`): the default `guestAccess=VIEW` reproduces the old slug grant;
  // a `guestAccess=NONE` project is not-found for a non-member.
  const project = await resolveReadableProject(db, actor, slug);

  const { nodes, edges } = await fetchProjectGraph(db, project.id);

  const byId = new Map(nodes.map((n) => [n.id, n]));

  // Filter trace points to live, in-Project nodes; dedupe. A stale / foreign /
  // soft-deleted id is silently dropped (ADR-0034).
  const validPoints = [...new Set(requestedIds)].filter((id) => byId.has(id));
  if (validPoints.length < 2) {
    return EMPTY_TRACE(validPoints);
  }

  const graph = buildUnifiedGraph(nodes, edges);
  const { nodeIds: onPathNodeIds, edgeIds: onPathEdgeIds } = onPathUnion(
    graph,
    validPoints,
  );
  addNestingAncestors(onPathNodeIds, byId);

  const validPointSet = new Set(validPoints);
  const { kept, keptIds, truncated, warning } = capTraceNodes(
    onPathNodeIds,
    byId,
    validPoints,
  );

  const resultNodes: TraceViewNode[] = keptIds
    .map((id) => byId.get(id))
    .filter((n): n is RawNode => n !== undefined)
    .map((n) => ({
      id: n.id,
      title: n.title,
      kind: n.kind,
      parentId: n.parentId,
      documentation: n.documentation,
      isTracePoint: validPointSet.has(n.id),
    }));

  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const resultEdges: TraceViewEdge[] = [...onPathEdgeIds]
    .map((id) => edgeById.get(id))
    .filter((e): e is RawEdge => e !== undefined)
    .filter((e) => kept.has(e.sourceId) && kept.has(e.targetId))
    .map((e) => ({
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
      interaction: e.interaction,
      label: e.label,
    }));

  return {
    nodes: resultNodes,
    edges: resultEdges,
    tracePointIds: validPoints.filter((id) => kept.has(id)),
    truncated,
    warning,
  };
}

// --- Named, saved Traces (#59 / ADR-0035) -----------------------------------
//
// Only the POINT SET persists; the on-path subgraph is recomputed on read by
// `getTraceView` (derived, ADR-0034). Reads (`listTraces`/`getTrace`) are
// capability-gated on `view` (ADR-0040, parity with `getTraceView`): the default
// `guestAccess=VIEW` reproduces the old slug grant; a `guestAccess=NONE` project
// is not-found for a non-member. Writes (`createTrace`/`renameTrace`/
// `deleteTrace`) gate on `edit` via `resolveWritableProject` — an EDITOR member
// or the owner may write; a guest-VIEW non-member is rejected with Forbidden at
// the service layer, not merely by hidden UI (ADR-0001/0040).

/**
 * One saved Trace as the CRUD surface returns it. `nodeIds` is the LIVE point set
 * only (points to soft-deleted Components are filtered at read time), so a Trace
 * can legitimately return fewer than two points — the derived view then shows the
 * insufficient-points empty state.
 */
export interface SavedTrace {
  id: string;
  name: string;
  nodeIds: string[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Resolve a Project by its capability slug for a Trace write, gated on `edit`
 * (ADR-0040). A Trace write is an edit, not owner-only — an EDITOR member can
 * create/rename/delete a Trace. Delegates to the slug-keyed write seam, so a true
 * non-member of a `guestAccess=NONE` project sees `NotFoundError` (non-disclosure,
 * the slug could be stale), while a non-owner non-member who CAN read (guest VIEW)
 * is rejected with `ForbiddenError` — the correct write-deny posture once read
 * access is already proven.
 */
async function resolveWritableProject(
  db: Db,
  actor: Actor,
  slug: string,
): Promise<{ id: string }> {
  return resolveWritableProjectBySlug(db, actor, slug, "edit");
}

/**
 * createTrace — requires `edit` capability (owner, ADMIN, or EDITOR member;
 * ADR-0040). Resolve the Project by slug → `resolveWritableProject`, filter
 * `nodeIds` to LIVE, in-Project Components (dedup) BEFORE writing; fewer than two
 * survivors → `ValidationError` (no useless 1-point Trace). Creates the Trace +
 * its `TracePoint` rows; the router wraps this in `db.$transaction` so they are
 * atomic. Name uniqueness among live Traces is enforced service-primary
 * (findFirst pre-check → `ConflictError`) with the partial unique index as a
 * TOCTOU backstop (P2002 narrowed via `isTraceNameCollision` → same
 * `ConflictError`) (ADR-0010).
 */
export async function createTrace(
  db: Db,
  actor: Actor,
  input: CreateTraceInput,
): Promise<SavedTrace> {
  const { slug, name, nodeIds } = createTraceInput.parse(input);
  const project = await resolveWritableProject(db, actor, slug);

  const liveNodes = await db.node.findMany({
    where: { projectId: project.id, deletedAt: null, id: { in: nodeIds } },
    select: { id: true },
  });
  const liveIds = liveNodes.map((n) => n.id);
  if (liveIds.length < 2) {
    throw new ValidationError("A Trace needs at least two live trace points.");
  }

  const existing = await db.trace.findFirst({
    where: { projectId: project.id, name, deletedAt: null },
    select: { id: true },
  });
  if (existing) {
    throw new ConflictError(`A Trace named “${name}” already exists.`);
  }

  try {
    const trace = await db.trace.create({
      data: {
        projectId: project.id,
        name,
        points: { create: liveIds.map((nodeId) => ({ nodeId })) },
      },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });
    return { ...trace, nodeIds: liveIds };
  } catch (error) {
    if (isTraceNameCollision(error)) {
      throw new ConflictError(`A Trace named “${name}” already exists.`);
    }
    throw error;
  }
}

/** Drop points whose Component is soft-deleted: a point survives only when its
 *  joined `node` is live (`deletedAt: null`). The FK row may still exist (the
 *  normal removal path is the Node soft-delete, not a hard delete), so this
 *  read-time filter is what realizes the "ignore soft-deleted points" rule. */
function livePointIds(
  points: { nodeId: string; node: { deletedAt: Date | null } | null }[],
): string[] {
  return points
    .filter((p) => p.node !== null && p.node.deletedAt === null)
    .map((p) => p.nodeId);
}

/**
 * listTraces — capability-gated on `view` (ADR-0040). The Project's live Traces
 * (newest first), each with its LIVE `nodeIds` so the UI can show a count and
 * load. Soft-deleted-Component points are filtered out (see `livePointIds`).
 */
export async function listTraces(
  db: Db,
  actor: Actor | null,
  input: ListTracesInput,
): Promise<SavedTrace[]> {
  const { slug } = listTracesInput.parse(input);
  const { id: projectId } = await resolveReadableProject(db, actor, slug);

  const traces = await db.trace.findMany({
    where: { projectId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      createdAt: true,
      updatedAt: true,
      points: {
        select: { nodeId: true, node: { select: { deletedAt: true } } },
      },
    },
  });

  return traces.map(({ points, ...trace }) => ({
    ...trace,
    nodeIds: livePointIds(points),
  }));
}

/**
 * getTrace — capability-gated on `view` (ADR-0040). One live Trace by id, scoped
 * to the slug's Project (a foreign or soft-deleted traceId is `NotFound` — no
 * existence disclosure). Returns its LIVE `nodeIds`. The saved route reads this.
 */
export async function getTrace(
  db: Db,
  actor: Actor | null,
  input: GetTraceInput,
): Promise<SavedTrace> {
  const { slug, traceId } = getTraceInput.parse(input);
  const { id: projectId } = await resolveReadableProject(db, actor, slug);

  const trace = await db.trace.findFirst({
    where: { id: traceId, projectId, deletedAt: null },
    select: {
      id: true,
      name: true,
      createdAt: true,
      updatedAt: true,
      points: {
        select: { nodeId: true, node: { select: { deletedAt: true } } },
      },
    },
  });
  if (!trace) {
    throw new NotFoundError();
  }

  const { points, ...rest } = trace;
  return { ...rest, nodeIds: livePointIds(points) };
}

/**
 * renameTrace — requires `edit` capability (owner, ADMIN, or EDITOR member;
 * ADR-0040). `resolveWritableProject`, then rename the live Trace scoped to the
 * Project. Re-checks live-name uniqueness (pre-check + P2002 catch). Does NOT
 * change the point set — #59 keeps rename narrow; editing points is future work.
 */
export async function renameTrace(
  db: Db,
  actor: Actor,
  input: RenameTraceInput,
): Promise<SavedTrace> {
  const { slug, traceId, name } = renameTraceInput.parse(input);
  const project = await resolveWritableProject(db, actor, slug);

  const collision = await db.trace.findFirst({
    where: {
      projectId: project.id,
      name,
      deletedAt: null,
      id: { not: traceId },
    },
    select: { id: true },
  });
  if (collision) {
    throw new ConflictError(`A Trace named “${name}” already exists.`);
  }

  try {
    // Conditional write closes the TOCTOU race: scoping the predicate to the
    // live row (`deletedAt: null`) means a concurrent soft-delete between here
    // and the write yields `count === 0` (NotFound) rather than renaming a
    // tombstone.
    const { count } = await db.trace.updateMany({
      where: { id: traceId, projectId: project.id, deletedAt: null },
      data: { name },
    });
    if (count === 0) {
      throw new NotFoundError();
    }
  } catch (error) {
    if (isTraceNameCollision(error)) {
      throw new ConflictError(`A Trace named “${name}” already exists.`);
    }
    throw error;
  }

  const trace = await db.trace.findFirstOrThrow({
    where: { id: traceId, projectId: project.id },
    select: {
      id: true,
      name: true,
      createdAt: true,
      updatedAt: true,
      points: {
        select: { nodeId: true, node: { select: { deletedAt: true } } },
      },
    },
  });
  const { points, ...rest } = trace;
  return { ...rest, nodeIds: livePointIds(points) };
}

/**
 * deleteTrace — soft-delete requiring `edit` capability (owner, ADMIN, or EDITOR
 * member; ADR-0040). `resolveWritableProject`, then stamp `deletedAt`
 * + a fresh `deletionId` on the live Trace (mirroring `deleteNode`'s stamped
 * batch, ADR-0030). `TracePoint` rows are not separately stamped — they have no
 * `deletedAt` and ride the Trace (hard-cascade only). Idempotent: deleting an
 * already-deleted Trace is `NotFound` (it is not in the live set). Returns
 * `{ id, deletionId }` for a future undo — #59 ships no `restoreTrace` UI, but the
 * stamped id keeps that path forward-compatible (ADR-0030).
 */
export async function deleteTrace(
  db: Db,
  actor: Actor,
  input: DeleteTraceInput,
): Promise<{ id: string; deletionId: string }> {
  const { slug, traceId } = deleteTraceInput.parse(input);
  const project = await resolveWritableProject(db, actor, slug);

  const deletionId = randomUUID();
  // Conditional write closes the TOCTOU race: scoping the predicate to the live
  // row (`deletedAt: null`) means a concurrent soft-delete wins exactly once —
  // `count === 0` here is NotFound, so we never overwrite the first caller's
  // `deletionId` (which would invalidate the undo handle already returned to it).
  const { count } = await db.trace.updateMany({
    where: { id: traceId, projectId: project.id, deletedAt: null },
    data: { deletedAt: new Date(), deletionId },
  });
  if (count === 0) {
    throw new NotFoundError();
  }
  return { id: traceId, deletionId };
}

// --- Member-aware MCP read of a saved Trace (#60 / ADR-0017 + ADR-0022, #109) -

/**
 * getTraceMarkdownForActor — the member-aware MCP front door for one saved Trace,
 * addressed by **internal `traceId`** (never a slug). The token-path peer of the
 * slug-bound `getTrace`/`getTraceView`: it resolves the Trace → its Project →
 * the capability ladder (ADR-0040), gating on `view`, so a bearer-token Actor
 * reads a Trace under a project it OWNS or is a MEMBER of (member parity #109).
 *
 * `guestAccess` is forced to `NONE` on the token path (a token is never the
 * anonymous slug-holder the guest grant was defined for), so possession of a
 * slug — or a project's public guest grant — can never reach this path. This
 * mirrors `exportMarkdownForActor` exactly.
 *
 * A soft-deleted Trace, a Trace under a soft-deleted Project, an unknown id, or
 * a Trace the actor cannot read all surface as `NotFoundError`, which the MCP
 * adapter also collapses to one non-disclosing "not found" — existence never
 * leaks. A real, readable, but degenerate Trace (< 2 live trace points, its
 * Components soft-deleted out from under it) is NOT an error: it returns valid
 * markdown with an insufficient-points note (the markdown analogue of the web
 * empty state).
 *
 * The on-path subgraph is recomputed on every read (never stored, ADR-0034),
 * reusing the same pure primitives (`buildUnifiedGraph`/`onPathUnion`/
 * `addNestingAncestors`) and the same `capTraceNodes` cap rule as the in-app
 * Trace view, then serialized by the deterministic `serializeTrace`.
 */
export async function getTraceMarkdownForActor(
  db: Db,
  actor: Actor,
  input: McpTraceReadInput,
): Promise<{ markdown: string }> {
  const { traceId } = mcpTraceReadInput.parse(input);

  const trace = await db.trace.findFirst({
    where: { id: traceId, deletedAt: null },
    select: {
      id: true,
      name: true,
      project: {
        select: {
          id: true,
          title: true,
          ownerId: true,
          deletedAt: true,
          memberships: {
            where: { userId: actor.userId },
            select: { role: true },
            take: 1,
          },
        },
      },
      points: {
        select: { nodeId: true, node: { select: { deletedAt: true } } },
      },
    },
  });
  // A missing Trace, a soft-deleted Trace (filtered above), or a Trace under a
  // soft-deleted Project all collapse to one non-disclosing not-found.
  if (!trace) {
    throw new NotFoundError();
  }
  if (trace.project.deletedAt !== null) {
    throw new NotFoundError();
  }
  const cap = resolveCapability(
    actor,
    { ownerId: trace.project.ownerId, guestAccess: "NONE" },
    trace.project.memberships[0] ?? null,
  );
  if (!capabilityAtLeast(cap, "view")) {
    throw new NotFoundError();
  }

  const { nodes, edges } = await fetchProjectGraph(db, trace.project.id);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const liveIds = livePointIds(trace.points);
  const validPoints = [...new Set(liveIds)].filter((id) => byId.has(id));

  const toSerializerNode = (n: RawNode): SerializerNode => ({
    id: n.id,
    parentId: n.parentId,
    title: n.title,
    kind: n.kind,
    documentation: n.documentation,
  });

  // Degenerate-but-owned Trace: valid markdown with the insufficient-points note
  // (NOT a 404 — that would conflate "not yours" with "currently empty").
  if (validPoints.length < 2) {
    return {
      markdown: serializeTrace({
        project: { title: trace.project.title },
        traceName: trace.name,
        nodes: [],
        edges: [],
        tracePointIds: validPoints,
        truncated: false,
        warning: null,
      }),
    };
  }

  const graph = buildUnifiedGraph(nodes, edges);
  const { nodeIds: onPathNodeIds, edgeIds: onPathEdgeIds } = onPathUnion(
    graph,
    validPoints,
  );
  addNestingAncestors(onPathNodeIds, byId);

  const { kept, keptIds, truncated, warning } = capTraceNodes(
    onPathNodeIds,
    byId,
    validPoints,
  );

  const nodesOut = keptIds
    .map((id) => byId.get(id))
    .filter((n): n is RawNode => n !== undefined)
    .map(toSerializerNode);

  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const edgesOut = [...onPathEdgeIds]
    .map((id) => edgeById.get(id))
    .filter((e): e is RawEdge => e !== undefined)
    .filter((e) => kept.has(e.sourceId) && kept.has(e.targetId))
    .map((e) => ({
      id: e.id,
      sourceId: e.sourceId,
      targetId: e.targetId,
      interaction: e.interaction,
      label: e.label,
    }));

  return {
    markdown: serializeTrace({
      project: { title: trace.project.title },
      traceName: trace.name,
      nodes: nodesOut,
      edges: edgesOut,
      tracePointIds: validPoints.filter((id) => kept.has(id)),
      truncated,
      warning,
    }),
  };
}
