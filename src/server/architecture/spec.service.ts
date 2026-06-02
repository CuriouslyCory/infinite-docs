import { Prisma } from "../../../generated/prisma/client";
import { assertCanWrite } from "./access";
import type { Actor, Db } from "./actor";
import { NotFoundError, ValidationError } from "./errors";
import { createNode, deleteNode } from "./node.service";
import {
  parseSpec,
  parseSpecDiff,
  type ExistingGeneratedComponent,
} from "./spec-parser";
import {
  applySpecInput,
  previewSpecInput,
  type ApplySpecInput,
  type NodeKind,
  type PreviewSpecInput,
  type SpecKind,
} from "~/lib/schemas";

/** A NEW Component the apply will create (informational in the preview). */
export interface SpecPreviewNew {
  specKey: string;
  title: string;
  kind: NodeKind;
}

/** A CHANGED Component — matched by key, derived fields differ. */
export interface SpecPreviewChanged {
  specKey: string;
  nodeId: string;
  title: string;
  previousTitle: string;
}

/**
 * A DROPPED Component — in the graph, gone from the re-parsed Spec.
 * `hasIncidentConnections` flags that deleting it would also remove Connections
 * (the loss the modal must make explicit before apply; #64 / ADR-0029).
 */
export interface SpecPreviewDropped {
  nodeId: string;
  specKey: string;
  title: string;
  hasIncidentConnections: boolean;
}

export interface SpecPreview {
  parseError: string | null;
  hasExistingSpec: boolean;
  new: SpecPreviewNew[];
  changed: SpecPreviewChanged[];
  dropped: SpecPreviewDropped[];
}

export interface ApplySpecResult {
  specId: string;
  ownerNodeId: string;
  created: number;
  overwritten: number;
  detached: number;
  deleted: number;
}

// A simple sibling grid so newly-generated Components don't pile up at the
// origin on first attach (philosophy #2 — good defaults). Layout is a canvas
// concern, not part of the Spec, so positions are derived here, never persisted
// from the parser. Auto-layout of generated subgraphs can deepen later (#65/#66).
const GRID_COLS = 4;
const GRID_DX = 240;
const GRID_DY = 140;

async function loadOwnerForWrite(
  db: Db,
  actor: Actor,
  ownerNodeId: string,
): Promise<{ projectId: string }> {
  const owner = await db.node.findFirst({
    where: { id: ownerNodeId, deletedAt: null },
    select: { projectId: true },
  });
  if (!owner) {
    throw new NotFoundError();
  }
  const project = await db.project.findFirst({
    where: { id: owner.projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);
  return { projectId: owner.projectId };
}

async function loadGeneratedChildren(
  db: Db,
  specId: string,
): Promise<ExistingGeneratedComponent[]> {
  const rows = await db.node.findMany({
    where: { sourceSpecId: specId, deletedAt: null, specKey: { not: null } },
    select: { id: true, specKey: true, title: true, kind: true, metadata: true },
  });
  return rows.map((row) => ({
    id: row.id,
    specKey: row.specKey!,
    title: row.title,
    kind: row.kind,
    metadata: row.metadata,
  }));
}

/**
 * The dropped Node ids whose subtree has at least one incident live Connection
 * — i.e. deleting them would lose a Connection (surfaced before apply; ADR-0029).
 * One recursive descent over all dropped roots, then one Edge query, so the cost
 * is two queries regardless of how many Components are dropped.
 */
async function droppedRootsWithConnections(
  db: Db,
  projectId: string,
  droppedNodeIds: string[],
): Promise<Set<string>> {
  if (droppedNodeIds.length === 0) return new Set();

  const pairs = await db.$queryRaw<{ rootId: string; nodeId: string }[]>`
    WITH RECURSIVE sub AS (
      SELECT n.id AS "rootId", n.id AS "nodeId"
      FROM "Node" n
      WHERE n.id IN (${Prisma.join(droppedNodeIds)})
        AND n."projectId" = ${projectId}
        AND n."deletedAt" IS NULL
      UNION ALL
      SELECT s."rootId", c.id
      FROM "Node" c
      JOIN sub s ON c."parentId" = s."nodeId"
      WHERE c."projectId" = ${projectId}
        AND c."deletedAt" IS NULL
    )
    SELECT "rootId", "nodeId" FROM sub`;

  const rootsByNode = new Map<string, string[]>();
  for (const { rootId, nodeId } of pairs) {
    const list = rootsByNode.get(nodeId) ?? [];
    list.push(rootId);
    rootsByNode.set(nodeId, list);
  }
  const allNodeIds = [...rootsByNode.keys()];

  const edges = await db.edge.findMany({
    where: {
      projectId,
      deletedAt: null,
      OR: [{ sourceId: { in: allNodeIds } }, { targetId: { in: allNodeIds } }],
    },
    select: { sourceId: true, targetId: true },
  });

  const flagged = new Set<string>();
  for (const edge of edges) {
    for (const endpoint of [edge.sourceId, edge.targetId]) {
      for (const root of rootsByNode.get(endpoint) ?? []) {
        flagged.add(root);
      }
    }
  }
  return flagged;
}

/**
 * Read-only preview powering the attach/merge UX (#64 / ADR-0029): parse the
 * pasted Spec, diff it against the owner Component's existing generated children,
 * and return the classification for the conflict modal. Writes NOTHING — cancel
 * is zero writes, and a re-parse must never mutate before the user confirms.
 * Owner-only (writes-grade authz, since it's a precursor to a write and reads
 * non-public structure). `source` is UNTRUSTED, bounded, never interpolated.
 */
export async function previewSpec(
  db: Db,
  actor: Actor,
  input: PreviewSpecInput,
): Promise<SpecPreview> {
  const { ownerNodeId, kind, source } = previewSpecInput.parse(input);
  const owner = await loadOwnerForWrite(db, actor, ownerNodeId);

  const existingSpec = await db.spec.findFirst({
    where: { ownerNodeId, deletedAt: null },
    select: { id: true },
  });
  const hasExistingSpec = existingSpec !== null;

  const parsed = parseSpec(kind, source);
  if (!parsed.ok) {
    return {
      parseError: parsed.parseError,
      hasExistingSpec,
      new: [],
      changed: [],
      dropped: [],
    };
  }

  const existingChildren = existingSpec
    ? await loadGeneratedChildren(db, existingSpec.id)
    : [];
  const diff = parseSpecDiff(parsed.tree, existingChildren);

  const flagged = await droppedRootsWithConnections(
    db,
    owner.projectId,
    diff.dropped.map((d) => d.nodeId),
  );

  return {
    parseError: null,
    hasExistingSpec,
    new: diff.new.map((n) => ({
      specKey: n.specKey,
      title: n.title,
      kind: n.kind,
    })),
    changed: diff.changed.map((c) => ({
      specKey: c.specKey,
      nodeId: c.nodeId,
      title: c.parsed.title,
      previousTitle: c.existing.title,
    })),
    dropped: diff.dropped.map((d) => ({
      nodeId: d.nodeId,
      specKey: d.specKey,
      title: d.title,
      hasIncidentConnections: flagged.has(d.nodeId),
    })),
  };
}

/**
 * Applies a previewed Spec (#64 / ADR-0029). RE-PARSES and RE-DIFFS server-side
 * — the client's tree is never trusted (the source is untrusted) — then applies
 * the user's per-item resolutions:
 *  - NEW   → created (provenance + position set); a generated Component is an
 *            ordinary Node (it nests, connects, descends, documents).
 *  - CHANGED overwrite → refresh title/kind/metadata; optionally wipe docs;
 *            id, position, and incident Connections are ALWAYS preserved.
 *  - CHANGED skip → untouched (the default for an unresolved key).
 *  - DROPPED delete → soft-delete subtree + incident Connections (ADR-0008).
 *  - DROPPED keep (the default) → detach from the Spec, retaining the now
 *            user-owned Component with its docs and Connections.
 *
 * MUST run inside the caller's transaction (the router wraps it) so a per-row
 * reject rolls the whole merge back — never a partial apply.
 */
export async function applySpec(
  db: Db,
  actor: Actor,
  input: ApplySpecInput,
): Promise<ApplySpecResult> {
  const { ownerNodeId, kind, source, changed, dropped } =
    applySpecInput.parse(input);
  const owner = await loadOwnerForWrite(db, actor, ownerNodeId);

  // Re-parse before any write. The user only reaches apply after a clean
  // preview, so a failure here means the source changed under them or hit a
  // bound — either way, generate nothing (never partial).
  const parsed = parseSpec(kind, source);
  if (!parsed.ok) {
    throw new ValidationError(`This spec did not parse: ${parsed.parseError}`);
  }

  const specId = await upsertLiveSpec(db, owner.projectId, ownerNodeId, kind, source);

  const existingChildren = await loadGeneratedChildren(db, specId);
  const diff = parseSpecDiff(parsed.tree, existingChildren);

  const changedByKey = new Map(changed.map((c) => [c.specKey, c]));
  const droppedByNode = new Map(dropped.map((d) => [d.nodeId, d]));

  // 1) CHANGED. skip (default) is a no-op; overwrite refreshes derived fields
  //    and optionally wipes docs. Position + Connections are never touched.
  let overwritten = 0;
  for (const change of diff.changed) {
    const resolution = changedByKey.get(change.specKey);
    if (!resolution || resolution.action === "skip") continue;
    const data: Prisma.NodeUpdateInput = {
      title: change.parsed.title,
      kind: change.parsed.kind,
      metadata: change.parsed.metadata ?? Prisma.JsonNull,
    };
    if (resolution.wipeDocumentation) data.documentation = "";
    await db.node.update({ where: { id: change.nodeId }, data });
    overwritten += 1;
  }

  // 2) DROPPED deletes first, collecting every cascaded id so a kept descendant
  //    of a deleted ancestor is not double-processed (delete cascades
  //    structurally — ADR-0008 — so it wins over a keep on a descendant).
  let deleted = 0;
  const cascaded = new Set<string>();
  for (const drop of diff.dropped) {
    if (droppedByNode.get(drop.nodeId)?.action !== "delete") continue;
    if (cascaded.has(drop.nodeId)) continue;
    const result = await deleteNode(db, actor, { id: drop.nodeId });
    for (const id of result.nodeIds) cascaded.add(id);
    deleted += 1;
  }

  // 3) DROPPED keep (default) → detach, unless already cascaded by a delete.
  let detached = 0;
  for (const drop of diff.dropped) {
    if (droppedByNode.get(drop.nodeId)?.action === "delete") continue;
    if (cascaded.has(drop.nodeId)) continue;
    await db.node.update({
      where: { id: drop.nodeId },
      data: { sourceSpecId: null, specKey: null },
    });
    detached += 1;
  }

  // 4) NEW, in pre-order so every parent id is resolved before its children. A
  //    new node's parent is the owner (top-level), an existing matched
  //    Component, or another new node created earlier in this loop.
  const keyToId: Record<string, string> = { ...diff.matchedKeyToId };
  const gridCounts = new Map<string, number>();
  let created = 0;
  for (const node of diff.new) {
    const parentId =
      node.parentSpecKey === null
        ? ownerNodeId
        : (keyToId[node.parentSpecKey] ?? ownerNodeId);
    const slot = gridCounts.get(parentId) ?? 0;
    gridCounts.set(parentId, slot + 1);

    const newNode = await createNode(db, actor, {
      projectId: owner.projectId,
      parentId,
      kind: node.kind,
      title: node.title,
      documentation: node.documentation,
      metadata: node.metadata,
      sourceSpecId: specId,
      specKey: node.specKey,
      posX: (slot % GRID_COLS) * GRID_DX,
      posY: Math.floor(slot / GRID_COLS) * GRID_DY,
    });
    keyToId[node.specKey] = newNode.id;
    created += 1;
  }

  return { specId, ownerNodeId, created, overwritten, detached, deleted };
}

// The live Spec on a Component is 1:1 (partial index `idx_spec_owner_live`), so
// re-attach reuses the existing live row rather than inserting a second (which
// would violate the index). parseError is cleared — we only reach here on a
// successful parse.
async function upsertLiveSpec(
  db: Db,
  projectId: string,
  ownerNodeId: string,
  kind: SpecKind,
  source: string,
): Promise<string> {
  const existing = await db.spec.findFirst({
    where: { ownerNodeId, deletedAt: null },
    select: { id: true },
  });
  if (existing) {
    await db.spec.update({
      where: { id: existing.id },
      data: { kind, source, parsedAt: new Date(), parseError: null },
    });
    return existing.id;
  }
  const created = await db.spec.create({
    data: {
      projectId,
      ownerNodeId,
      kind,
      source,
      parsedAt: new Date(),
      parseError: null,
    },
  });
  return created.id;
}
