import {
  getTraceViewInput,
  type GetTraceViewInput,
  type Interaction,
  type NodeKind,
} from "~/lib/schemas";
import type { Actor, Db } from "./actor";
import { NotFoundError } from "./errors";

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
          low.set(frame.node, Math.min(low.get(frame.node)!, disc.get(neighbor)!));
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
    while (current !== null && !nodeIds.has(current) && depth < ANCESTRY_DEPTH_CAP) {
      nodeIds.add(current);
      current = byId.get(current)?.parentId ?? null;
      depth++;
    }
  }
}

export async function getTraceView(
  db: Db,
  _actor: Actor | null,
  input: GetTraceViewInput,
): Promise<TraceView> {
  const { slug, nodeIds: requestedIds } = getTraceViewInput.parse(input);

  // Slug-bind gate, in parity with `getCanvas` (ADR-0002 / ADR-0034): possession
  // of the slug IS the read grant, so `_actor` is accepted only to match the
  // readable-procedure signature and never consulted. Both owner and slug-only
  // viewer reach this read.
  const project = await db.project.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true },
  });
  if (!project) {
    throw new NotFoundError();
  }

  // Single round trip (ADR-0001): the live node universe (drives nesting links,
  // ancestors, and display) and the live Connection set, both flat findManys on
  // indexed columns — no CTE needed for the fetch.
  const [nodes, edges] = await Promise.all([
    db.node.findMany({
      where: { projectId: project.id, deletedAt: null },
      select: {
        id: true,
        title: true,
        kind: true,
        parentId: true,
        documentation: true,
      },
    }) as Promise<RawNode[]>,
    db.edge.findMany({
      where: { projectId: project.id, deletedAt: null },
      select: {
        id: true,
        sourceId: true,
        targetId: true,
        interaction: true,
        label: true,
      },
    }) as Promise<RawEdge[]>,
  ]);

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

  // Enforce the node cap deterministically: sort by id so truncation is stable,
  // slice, and keep only Connections whose BOTH endpoints survived. Truncate +
  // surface — never hang, never throw (ADR-0034).
  let truncated = false;
  let warning: string | null = null;
  let keptIds = [...onPathNodeIds].sort();
  if (keptIds.length > TRACE_NODE_CAP) {
    truncated = true;
    keptIds = keptIds.slice(0, TRACE_NODE_CAP);
    warning = `Showing the first ${TRACE_NODE_CAP} Components on these paths — refine your trace points to narrow it.`;
  }
  const kept = new Set(keptIds);
  const validPointSet = new Set(validPoints);

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
