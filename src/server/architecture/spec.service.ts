import { Prisma } from "../../../generated/prisma/client";
import { assertCanWrite } from "./access";
import type { Actor, Db } from "./actor";
import { activeDuplicateWhere } from "./edge.service";
import { NotFoundError, ValidationError } from "./errors";
import { deleteNode } from "./node.service";
import {
  diffConnections,
  parseSpec,
  parseSpecDiff,
  type ExistingGeneratedComponent,
  type ExistingGeneratedConnection,
  type SpecChangedField,
} from "./spec-parser";
import {
  applySpecInput,
  previewSpecInput,
  type ApplySpecInput,
  type NodeKind,
  type ParsedConnection,
  type PreviewSpecInput,
  type SpecKind,
} from "~/lib/schemas";

/** A NEW Component the apply will create (informational in the preview). */
export interface SpecPreviewNew {
  specKey: string;
  title: string;
  kind: NodeKind;
}

/**
 * A CHANGED Component — matched by key, derived fields differ. `changedFields`
 * names exactly what differs so the conflict modal can show the change even when
 * the title is unchanged (a kind- or metadata-only diff would otherwise render a
 * "changed" row with nothing visibly different; #64). `kind`/`previousKind` let
 * the modal render the kind delta inline.
 */
export interface SpecPreviewChanged {
  specKey: string;
  nodeId: string;
  title: string;
  previousTitle: string;
  kind: NodeKind;
  previousKind: NodeKind;
  changedFields: SpecChangedField[];
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
  // FK Connections the apply will auto-reconcile (#76). Informational only —
  // Connections carry no user content, so they are never user-resolved like
  // Components; surfaced so the modal can say what will be drawn/removed.
  connectionsToCreate: number;
  connectionsToRemove: number;
}

export interface ApplySpecResult {
  specId: string;
  ownerNodeId: string;
  created: number;
  overwritten: number;
  detached: number;
  deleted: number;
  connectionsCreated: number;
  connectionsRemoved: number;
}

/**
 * Interactive-transaction margin for the bulk Spec/graph appliers, shared by the
 * tRPC router and the MCP tool catalog so the two cannot drift. Sized well above
 * the worst-case parse + bulk-insert cost for a `MAX_PARSED_NODES`-sized Spec; it
 * is a safety ceiling on a cold connection, NOT the performance fix — `applySpec`
 * bulk-inserts level by level (a handful of round trips), so the apply never
 * approaches this bound on the happy path. (The pre-fix per-node `createNode`
 * loop tripped the 5 s default at ~50 queries; this margin would only have
 * deferred that, hence the rewrite below is the real fix.)
 */
export const BULK_WRITE_TIMEOUT_MS = 30_000;

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
    select: {
      id: true,
      specKey: true,
      title: true,
      kind: true,
      metadata: true,
    },
  });
  return rows.map((row) => ({
    id: row.id,
    specKey: row.specKey!,
    title: row.title,
    kind: row.kind,
    metadata: row.metadata,
  }));
}

async function loadGeneratedConnections(
  db: Db,
  specId: string,
): Promise<ExistingGeneratedConnection[]> {
  const rows = await db.edge.findMany({
    where: { sourceSpecId: specId, deletedAt: null, specKey: { not: null } },
    select: { id: true, specKey: true, interaction: true, label: true },
  });
  return rows.map((row) => ({
    id: row.id,
    specKey: row.specKey!,
    interaction: row.interaction,
    label: row.label,
  }));
}

/**
 * Auto-reconciles a Spec's FK Connections (#76 / ADR-0033). Resolves each parsed
 * connection's endpoint `specKey`s to live Node ids via `keyToId` (built from the
 * Component reconcile), then: creates the new ones with Spec provenance,
 * soft-deletes the ones whose FK vanished, and refreshes interaction/label on the
 * changed ones. Endpoints always resolve (bounds guarantees both are tree nodes,
 * all of which are matched/created and so in `keyToId`); a stray unresolved or
 * self-pair endpoint is skipped rather than failing the merge.
 *
 * Slot-adoption: the directional de-dupe index forbids a second active edge in a
 * `(projectId, source, target, interaction)` slot. If a slot is already occupied
 * (a hand-drawn Connection, or one from another Spec), STAMP that edge with this
 * Spec's provenance and refresh its label instead of inserting a duplicate the
 * index would reject — so the Spec adopts the existing arrow and reconciles it on
 * future re-parses.
 */
async function reconcileConnections(
  db: Db,
  projectId: string,
  specId: string,
  keyToId: Record<string, string>,
  parsedConnections: ParsedConnection[],
): Promise<{ connectionsCreated: number; connectionsRemoved: number }> {
  const existing = await loadGeneratedConnections(db, specId);
  const diff = diffConnections(parsedConnections, existing);

  let connectionsCreated = 0;
  const freshRows: Prisma.EdgeCreateManyInput[] = [];
  for (const connection of diff.new) {
    const sourceId = keyToId[connection.sourceKey];
    const targetId = keyToId[connection.targetKey];
    if (!sourceId || !targetId || sourceId === targetId) continue;
    const label = connection.label ?? null;

    const occupant = await db.edge.findFirst({
      where: activeDuplicateWhere(
        projectId,
        sourceId,
        targetId,
        connection.interaction,
      ),
      select: { id: true },
    });
    if (occupant) {
      await db.edge.update({
        where: { id: occupant.id },
        data: { sourceSpecId: specId, specKey: connection.specKey, label },
      });
      connectionsCreated += 1;
    } else {
      freshRows.push({
        projectId,
        sourceId,
        targetId,
        interaction: connection.interaction,
        label,
        sourceSpecId: specId,
        specKey: connection.specKey,
      });
    }
  }
  if (freshRows.length > 0) {
    const result = await db.edge.createMany({ data: freshRows });
    connectionsCreated += result.count;
  }

  // An in-place update is safe ONLY while it cannot move the Edge into an
  // occupied de-dupe slot. The de-dupe key is (projectId, source, target,
  // interaction); endpoints never change under a stable specKey (see
  // diffConnections' CONTRACT), so the only slot-moving field is `interaction`.
  // The sole emitter today (SQL-DDL) always uses REQUEST, so `diff.changed` is
  // label-only and the key is untouched. A future parser that varies a
  // Connection's interaction MUST adopt an occupant here the way the `diff.new`
  // path above does, or this update can trip the unique index and roll back.
  for (const change of diff.changed) {
    await db.edge.update({
      where: { id: change.id },
      data: {
        interaction: change.parsed.interaction,
        label: change.parsed.label ?? null,
      },
    });
  }

  let connectionsRemoved = 0;
  if (diff.dropped.length > 0) {
    const result = await db.edge.updateMany({
      where: { id: { in: diff.dropped.map((d) => d.id) }, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    connectionsRemoved = result.count;
  }

  return { connectionsCreated, connectionsRemoved };
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
      connectionsToCreate: 0,
      connectionsToRemove: 0,
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

  // FK Connection reconcile is auto (no user resolution), so the preview only
  // counts what will change. Endpoints are guaranteed present by the parse bound,
  // so `new`/`dropped` counts need no node-id resolution here.
  const existingConnections = existingSpec
    ? await loadGeneratedConnections(db, existingSpec.id)
    : [];
  const connectionDiff = diffConnections(
    parsed.connections,
    existingConnections,
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
      kind: c.parsed.kind,
      previousKind: c.existing.kind,
      changedFields: c.changedFields,
    })),
    dropped: diff.dropped.map((d) => ({
      nodeId: d.nodeId,
      specKey: d.specKey,
      title: d.title,
      hasIncidentConnections: flagged.has(d.nodeId),
    })),
    connectionsToCreate: connectionDiff.new.length,
    connectionsToRemove: connectionDiff.dropped.length,
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

  const specId = await upsertLiveSpec(
    db,
    owner.projectId,
    ownerNodeId,
    kind,
    source,
  );

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

  // 3) DROPPED keep (default) → detach in ONE batch, excluding any already
  //    cascaded by a delete above. One updateMany instead of a write per row.
  const detachIds = diff.dropped
    .filter(
      (drop) =>
        droppedByNode.get(drop.nodeId)?.action !== "delete" &&
        !cascaded.has(drop.nodeId),
    )
    .map((drop) => drop.nodeId);
  if (detachIds.length > 0) {
    await db.node.updateMany({
      where: { id: { in: detachIds } },
      data: { sourceSpecId: null, specKey: null },
    });
  }
  const detached = detachIds.length;

  // 4) NEW. Bulk-insert level by level rather than one self-validating
  //    `createNode` per node. `applySpec` already authorized the owner once
  //    (`loadOwnerForWrite`), every parent is the owner or a node matched /
  //    created in THIS transaction, and the Spec was just upserted — exactly the
  //    invariants `createNode`'s per-row guards (project / parent / spec
  //    existence) re-check, so skipping them here is safe, not a shortcut. A
  //    "wave" is the set of new nodes whose parent id is already known;
  //    `createManyAndReturn` yields the fresh ids (matched back by `specKey` —
  //    its return order is NOT guaranteed), which unlock the next wave. Over a
  //    network DB this turns ~4 round trips per node into one per tree level
  //    (philosophy #1) — the fix for the apply-phase timeout, not the raised
  //    transaction bound.
  const keyToId: Record<string, string> = { ...diff.matchedKeyToId };
  const gridCounts = new Map<string, number>();
  let created = 0;
  let pending = diff.new;
  while (pending.length > 0) {
    let ready = pending.filter(
      (node) =>
        node.parentSpecKey === null ||
        keyToId[node.parentSpecKey] !== undefined,
    );
    let next = pending.filter(
      (node) =>
        node.parentSpecKey !== null &&
        keyToId[node.parentSpecKey] === undefined,
    );
    // No progress means a parent key never resolves (a parsed parent that
    // dropped out of the tree). Flush the remainder under the owner, mirroring
    // the `?? ownerNodeId` fallback, so the loop can never spin forever.
    if (ready.length === 0) {
      ready = pending;
      next = [];
    }

    const rows = ready.map((node) => {
      const parentId =
        node.parentSpecKey === null
          ? ownerNodeId
          : (keyToId[node.parentSpecKey] ?? ownerNodeId);
      const slot = gridCounts.get(parentId) ?? 0;
      gridCounts.set(parentId, slot + 1);
      const row: Prisma.NodeCreateManyInput = {
        projectId: owner.projectId,
        parentId,
        kind: node.kind,
        title: node.title,
        sourceSpecId: specId,
        specKey: node.specKey,
        posX: (slot % GRID_COLS) * GRID_DX,
        posY: Math.floor(slot / GRID_COLS) * GRID_DY,
      };
      if (node.documentation !== undefined)
        row.documentation = node.documentation;
      if (node.metadata !== undefined) row.metadata = node.metadata;
      return row;
    });

    const inserted = await db.node.createManyAndReturn({
      data: rows,
      select: { id: true, specKey: true },
    });
    for (const row of inserted) {
      if (row.specKey !== null) keyToId[row.specKey] = row.id;
    }
    created += inserted.length;
    pending = next;
  }

  // 5) FK Connections (#76). `keyToId` now holds every endpoint candidate — the
  //    matched tables (seeded) and the freshly-created ones — so reconcile draws
  //    new FK edges, drops vanished ones, and refreshes changed ones in one pass.
  const { connectionsCreated, connectionsRemoved } = await reconcileConnections(
    db,
    owner.projectId,
    specId,
    keyToId,
    parsed.connections,
  );

  return {
    specId,
    ownerNodeId,
    created,
    overwritten,
    detached,
    deleted,
    connectionsCreated,
    connectionsRemoved,
  };
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
