import { beforeEach, describe, expect, it } from "vitest";

import { type Actor } from "../actor";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../errors";
import {
  connectCrossProject,
  deleteCrossProjectEdge,
  restoreCrossProjectEdge,
} from "../edge.service";
import {
  createEmbeddedComponent,
  createNode,
  deleteNode,
  getCanvas,
  listForeignComponentsViaPortal,
  restoreNode,
} from "../node.service";
import { createProject } from "../project.service";
import { resetDb, testDb } from "./helpers/test-db";

beforeEach(async () => {
  await resetDb();
});

function makeUser(name = "Owner") {
  return testDb.user.create({ data: { name } });
}

async function makeProject(ownerId: string, title = "System") {
  return createProject(testDb, { userId: ownerId }, { title });
}

/** Closes a project to members-only so a non-member cannot read it. */
async function closeProject(projectId: string) {
  await testDb.project.update({
    where: { id: projectId },
    data: { guestAccess: "NONE" },
  });
}

/**
 * A host Project with a host Component (`hostNode`) and a Project Portal
 * (`portal`) embedding a foreign Project that holds one Component (`foreignNode`).
 * The single `user` owns everything, so they can read the foreign target.
 */
async function seedHostAndForeign() {
  const user = await makeUser();
  const actor: Actor = { userId: user.id, via: "session" };
  const host = await makeProject(user.id, "Host");
  const foreign = await makeProject(user.id, "Foreign");

  const hostNode = await createNode(testDb, actor, {
    projectId: host.id,
    title: "Host Component",
  });
  const foreignNode = await createNode(testDb, actor, {
    projectId: foreign.id,
    title: "Foreign Component",
  });
  const portal = await createEmbeddedComponent(testDb, actor, {
    projectId: host.id,
    embeddedProjectId: foreign.id,
    title: "Foreign",
  });

  return { user, actor, host, foreign, hostNode, foreignNode, portal };
}

describe("connectCrossProject", () => {
  it("connects host → readable foreign and persists the derived foreignProjectId + foreignNodeId", async () => {
    const { actor, host, foreign, hostNode, foreignNode, portal } =
      await seedHostAndForeign();

    const edge = await connectCrossProject(testDb, actor, {
      hostProjectId: host.id,
      hostNodeId: hostNode.id,
      referenceNodeId: portal.id,
      foreignNodeId: foreignNode.id,
    });

    expect(edge.hostProjectId).toBe(host.id);
    expect(edge.hostNodeId).toBe(hostNode.id);
    expect(edge.referenceNodeId).toBe(portal.id);
    expect(edge.foreignNodeId).toBe(foreignNode.id);
    expect(edge.interaction).toBe("ASSOCIATION");
    expect(edge.deletedAt).toBeNull();
    // Non-disclosure: the internal foreign Project.id NEVER rides the service
    // return (the slice's headline invariant) — only the persisted row carries it.
    expect(
      (edge as unknown as Record<string, unknown>).foreignProjectId,
    ).toBeUndefined();

    const persisted = await testDb.crossProjectEdge.findUnique({
      where: { id: edge.id },
    });
    // The foreign project id is DERIVED server-side from the portal, never sent,
    // and is PERSISTED on the row (just not disclosed on the return).
    expect(persisted?.foreignProjectId).toBe(foreign.id);
    expect(persisted?.foreignNodeId).toBe(foreignNode.id);
  });

  it("throws NotFound (NOT Forbidden) when the foreign project is unreadable", async () => {
    const hostOwner = await makeUser("Host Owner");
    const targetOwner = await makeUser("Target Owner");
    const hostActor: Actor = { userId: hostOwner.id, via: "session" };
    const targetActor: Actor = { userId: targetOwner.id, via: "session" };
    const host = await makeProject(hostOwner.id, "Host");
    const foreign = await makeProject(targetOwner.id, "Private Foreign");

    const hostNode = await createNode(testDb, hostActor, {
      projectId: host.id,
      title: "Host Component",
    });
    const foreignNode = await createNode(testDb, targetActor, {
      projectId: foreign.id,
      title: "Foreign Component",
    });
    // The target owner (granted host EDITOR) places the portal, then closes the
    // foreign project so the host owner can no longer read it.
    await testDb.projectMembership.create({
      data: { projectId: host.id, userId: targetOwner.id, role: "EDITOR" },
    });
    const portal = await createEmbeddedComponent(testDb, targetActor, {
      projectId: host.id,
      embeddedProjectId: foreign.id,
      title: "Foreign",
    });
    await closeProject(foreign.id);

    // The host owner can edit the host and holds the portal, but cannot read the
    // foreign target → NotFound, never Forbidden (non-disclosure).
    await expect(
      connectCrossProject(testDb, hostActor, {
        hostProjectId: host.id,
        hostNodeId: hostNode.id,
        referenceNodeId: portal.id,
        foreignNodeId: foreignNode.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const count = await testDb.crossProjectEdge.count();
    expect(count).toBe(0);
  });

  it("throws Forbidden when host edit is missing — and never probes the foreign endpoint (gate order)", async () => {
    const hostOwner = await makeUser("Host Owner");
    const intruder = await makeUser("Intruder");
    const hostActor: Actor = { userId: hostOwner.id, via: "session" };
    const intruderActor: Actor = { userId: intruder.id, via: "session" };
    const host = await makeProject(hostOwner.id, "Host");
    const foreign = await makeProject(hostOwner.id, "Foreign");

    const hostNode = await createNode(testDb, hostActor, {
      projectId: host.id,
      title: "Host Component",
    });
    const portal = await createEmbeddedComponent(testDb, hostActor, {
      projectId: host.id,
      embeddedProjectId: foreign.id,
      title: "Foreign",
    });

    // The intruder cannot edit the host. Even with a BOGUS foreignNodeId (the
    // foreign existence is never probed), the host-edit gate fires FIRST → Forbidden.
    await expect(
      connectCrossProject(testDb, intruderActor, {
        hostProjectId: host.id,
        hostNodeId: hostNode.id,
        referenceNodeId: portal.id,
        foreignNodeId: "does-not-exist",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const count = await testDb.crossProjectEdge.count();
    expect(count).toBe(0);
  });

  it("rejects a same-project link (portal embeds the host itself) with ValidationError", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const host = await makeProject(user.id, "Host");

    const hostNode = await createNode(testDb, actor, {
      projectId: host.id,
      title: "Host Component",
    });
    const targetInHost = await createNode(testDb, actor, {
      projectId: host.id,
      title: "Target In Host",
    });
    // A portal that embeds its OWN host (createEmbeddedComponent rejects self-embed,
    // so force the degenerate row directly to exercise the service's same-project
    // reject independently).
    const selfPortal = await testDb.node.create({
      data: {
        projectId: host.id,
        title: "Self Portal",
        embeddedProjectId: host.id,
      },
    });

    await expect(
      connectCrossProject(testDb, actor, {
        hostProjectId: host.id,
        hostNodeId: hostNode.id,
        referenceNodeId: selfPortal.id,
        foreignNodeId: targetInHost.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const count = await testDb.crossProjectEdge.count();
    expect(count).toBe(0);
  });

  it("throws NotFound when the referenceNode is not a portal", async () => {
    const { actor, host, hostNode, foreignNode } = await seedHostAndForeign();
    // A plain host Node (no embeddedProjectId) used as the reference.
    const notAPortal = await createNode(testDb, actor, {
      projectId: host.id,
      title: "Not A Portal",
    });

    await expect(
      connectCrossProject(testDb, actor, {
        hostProjectId: host.id,
        hostNodeId: hostNode.id,
        referenceNodeId: notAPortal.id,
        foreignNodeId: foreignNode.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const count = await testDb.crossProjectEdge.count();
    expect(count).toBe(0);
  });

  it("throws NotFound when the foreign endpoint is not a live node in the foreign project", async () => {
    const { actor, host, hostNode, portal } = await seedHostAndForeign();

    await expect(
      connectCrossProject(testDb, actor, {
        hostProjectId: host.id,
        hostNodeId: hostNode.id,
        referenceNodeId: portal.id,
        foreignNodeId: "does-not-exist",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("getCanvas cross-project render (#122)", () => {
  it("surfaces the foreign endpoint as a marked boundary proxy + host→xproxy interior edge in the host scope", async () => {
    const { actor, host, foreign, hostNode, foreignNode, portal } =
      await seedHostAndForeign();

    const edge = await connectCrossProject(testDb, actor, {
      hostProjectId: host.id,
      hostNodeId: hostNode.id,
      referenceNodeId: portal.id,
      foreignNodeId: foreignNode.id,
    });

    const canvas = await getCanvas(testDb, actor, {
      slug: host.slug,
      canvasNodeId: null,
    });

    const proxy = canvas.boundaryProxies.find(
      (p) => p.realEndpointId === foreignNode.id,
    );
    expect(proxy).toBeDefined();
    expect(proxy?.nodeId).toBe(`xproxy_${edge.id}`);
    expect(proxy?.title).toBe("Foreign Component");
    expect(proxy?.foreignProjectTitle).toBe(foreign.title);

    const interiorEdge = canvas.interiorEdges.find((e) => e.id === edge.id);
    expect(interiorEdge).toBeDefined();
    expect(interiorEdge?.sourceRepr).toBe(hostNode.id);
    expect(interiorEdge?.targetRepr).toBe(`xproxy_${edge.id}`);
  });

  it("does NOT show the host-anchored edge in the foreign project viewed standalone", async () => {
    const { actor, host, foreign, hostNode, foreignNode, portal } =
      await seedHostAndForeign();

    await connectCrossProject(testDb, actor, {
      hostProjectId: host.id,
      hostNodeId: hostNode.id,
      referenceNodeId: portal.id,
      foreignNodeId: foreignNode.id,
    });

    // Open the FOREIGN project by its own slug (no embedPath — standalone).
    const foreignCanvas = await getCanvas(testDb, actor, {
      slug: foreign.slug,
      canvasNodeId: null,
    });

    expect(foreignCanvas.activeProject.id).toBe(foreign.id);
    expect(foreignCanvas.boundaryProxies).toHaveLength(0);
    expect(foreignCanvas.interiorEdges).toHaveLength(0);
    void host;
  });

  it("emits NO cross-project proxy for a viewer whose foreign grant was revoked (firewall)", async () => {
    const hostOwner = await makeUser("Host Owner");
    const targetOwner = await makeUser("Target Owner");
    const hostActor: Actor = { userId: hostOwner.id, via: "session" };
    const targetActor: Actor = { userId: targetOwner.id, via: "session" };
    const host = await makeProject(hostOwner.id, "Host");
    const foreign = await makeProject(targetOwner.id, "Secret Foreign Name");
    await closeProject(foreign.id);

    const hostNode = await createNode(testDb, hostActor, {
      projectId: host.id,
      title: "Host Component",
    });
    const foreignNode = await createNode(testDb, targetActor, {
      projectId: foreign.id,
      title: "Foreign Component",
    });
    // The target owner (host EDITOR) places the portal and draws the cross-project
    // edge while they can read their own foreign project.
    await testDb.projectMembership.create({
      data: { projectId: host.id, userId: targetOwner.id, role: "EDITOR" },
    });
    const portal = await createEmbeddedComponent(testDb, targetActor, {
      projectId: host.id,
      embeddedProjectId: foreign.id,
      title: "Foreign",
    });
    const edge = await connectCrossProject(testDb, targetActor, {
      hostProjectId: host.id,
      hostNodeId: hostNode.id,
      referenceNodeId: portal.id,
      foreignNodeId: foreignNode.id,
    });

    // Grant the host owner VIEW on the foreign project, then revoke it — the host
    // owner now holds no foreign grant.
    const membership = await testDb.projectMembership.create({
      data: { projectId: foreign.id, userId: hostOwner.id, role: "VIEWER" },
    });
    await testDb.projectMembership.delete({ where: { id: membership.id } });

    const canvas = await getCanvas(testDb, hostActor, {
      slug: host.slug,
      canvasNodeId: null,
    });

    // The cross-project proxy and edge are absent — the firewall drops the row
    // whose foreign project the host owner cannot read. The foreign title never
    // reaches the wire.
    expect(
      canvas.boundaryProxies.find((p) => p.realEndpointId === foreignNode.id),
    ).toBeUndefined();
    expect(canvas.interiorEdges.find((e) => e.id === edge.id)).toBeUndefined();
    expect(JSON.stringify(canvas)).not.toContain("Secret Foreign Name");

    // And the target owner — who CAN read the foreign — still sees the proxy.
    const ownerView = await getCanvas(testDb, targetActor, {
      slug: host.slug,
      canvasNodeId: null,
    });
    expect(
      ownerView.boundaryProxies.find((p) => p.realEndpointId === foreignNode.id),
    ).toBeDefined();
  });
});

describe("listForeignComponentsViaPortal (#122)", () => {
  it("returns the foreign Components for a readable portal", async () => {
    const { actor, host, foreignNode, portal } = await seedHostAndForeign();

    const components = await listForeignComponentsViaPortal(testDb, actor, {
      slug: host.slug,
      referenceNodeId: portal.id,
    });

    expect(components.map((c) => c.id)).toContain(foreignNode.id);
    expect(components.find((c) => c.id === foreignNode.id)?.title).toBe(
      "Foreign Component",
    );
  });

  it("throws NotFound when the foreign project behind the portal is unreadable", async () => {
    const hostOwner = await makeUser("Host Owner");
    const targetOwner = await makeUser("Target Owner");
    const hostActor: Actor = { userId: hostOwner.id, via: "session" };
    const targetActor: Actor = { userId: targetOwner.id, via: "session" };
    const host = await makeProject(hostOwner.id, "Host");
    const foreign = await makeProject(targetOwner.id, "Private Foreign");

    await testDb.projectMembership.create({
      data: { projectId: host.id, userId: targetOwner.id, role: "EDITOR" },
    });
    const portal = await createEmbeddedComponent(testDb, targetActor, {
      projectId: host.id,
      embeddedProjectId: foreign.id,
      title: "Foreign",
    });
    await closeProject(foreign.id);

    await expect(
      listForeignComponentsViaPortal(testDb, hostActor, {
        slug: host.slug,
        referenceNodeId: portal.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFound when the referenceNode is not a portal", async () => {
    const { actor, host } = await seedHostAndForeign();
    const notAPortal = await createNode(testDb, actor, {
      projectId: host.id,
      title: "Not A Portal",
    });

    await expect(
      listForeignComponentsViaPortal(testDb, actor, {
        slug: host.slug,
        referenceNodeId: notAPortal.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

/** Draws a cross-project edge from the standard host/foreign seed. */
async function seedCrossEdge() {
  const seed = await seedHostAndForeign();
  const edge = await connectCrossProject(testDb, seed.actor, {
    hostProjectId: seed.host.id,
    hostNodeId: seed.hostNode.id,
    referenceNodeId: seed.portal.id,
    foreignNodeId: seed.foreignNode.id,
  });
  return { ...seed, edge };
}

describe("deleteCrossProjectEdge / restoreCrossProjectEdge (#123)", () => {
  it("round-trips: delete sets deletedAt (no deletionId), restore clears it", async () => {
    const { actor, edge } = await seedCrossEdge();

    const deleted = await deleteCrossProjectEdge(testDb, actor, { id: edge.id });
    expect(deleted.deletedAt).not.toBeNull();
    // Non-disclosure: the return never carries foreignProjectId.
    expect(
      (deleted as unknown as Record<string, unknown>).foreignProjectId,
    ).toBeUndefined();

    const afterDelete = await testDb.crossProjectEdge.findUnique({
      where: { id: edge.id },
    });
    expect(afterDelete?.deletedAt).not.toBeNull();
    // A lone delete mints NO deletionId (mirrors deleteEdge).
    expect(afterDelete?.deletionId).toBeNull();

    const restored = await restoreCrossProjectEdge(testDb, actor, {
      id: edge.id,
    });
    expect(restored.deletedAt).toBeNull();
    const afterRestore = await testDb.crossProjectEdge.findUnique({
      where: { id: edge.id },
    });
    expect(afterRestore?.deletedAt).toBeNull();
  });

  it("delete is HOST-edit gated: a non-host-editor is Forbidden (no foreign re-gate)", async () => {
    const { host, edge } = await seedCrossEdge();
    const intruder = await makeUser("Intruder");
    const intruderActor: Actor = { userId: intruder.id, via: "session" };

    await expect(
      deleteCrossProjectEdge(testDb, intruderActor, { id: edge.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const row = await testDb.crossProjectEdge.findUnique({
      where: { id: edge.id },
    });
    expect(row?.deletedAt).toBeNull();
    void host;
  });

  it("delete still succeeds for the host editor even if the foreign grant is gone", async () => {
    // Host owner draws the edge into their OWN foreign project, then loses read on
    // it (foreign re-owned + closed). Host-anchored delete must NOT re-gate foreign.
    const { actor, host, foreign, edge } = await seedCrossEdge();
    // Transfer the foreign project to a new owner and close it so `actor` cannot
    // read it any longer.
    const stranger = await makeUser("Stranger");
    await testDb.project.update({
      where: { id: foreign.id },
      data: { ownerId: stranger.id, guestAccess: "NONE" },
    });

    const deleted = await deleteCrossProjectEdge(testDb, actor, { id: edge.id });
    expect(deleted.deletedAt).not.toBeNull();
    void host;
  });

  it("restore throws NotFound for an unknown id and for an already-live row", async () => {
    const { actor, edge } = await seedCrossEdge();

    await expect(
      restoreCrossProjectEdge(testDb, actor, { id: "does-not-exist" }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // The freshly-created edge is live — nothing to restore.
    await expect(
      restoreCrossProjectEdge(testDb, actor, { id: edge.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lone-restore detaches the edge from its old cascade group so host-node undo still succeeds", async () => {
    // Delete the host node, sweeping the incident cross-project edge under a
    // deletionId. Lone-restore that edge (it goes live and MUST shed its old
    // deletionId), then undo the host-node delete — restoreNode must SUCCEED, not
    // ConflictError, and must not double-affect the already-live edge.
    const { actor, hostNode, edge } = await seedCrossEdge();

    const deleted = await testDb.$transaction((tx) =>
      deleteNode(tx, actor, { id: hostNode.id }),
    );
    expect(deleted.crossProjectEdgeIds).toContain(edge.id);

    const swept = await testDb.crossProjectEdge.findUnique({
      where: { id: edge.id },
    });
    expect(swept?.deletionId).toBe(deleted.deletionId);

    // Lone-restore the swept edge: it becomes live AND fully detaches from the
    // old cascade group (deletionId cleared), so a later host-node undo won't
    // re-gather it into its own dedup pre-check.
    await restoreCrossProjectEdge(testDb, actor, { id: edge.id });
    const relived = await testDb.crossProjectEdge.findUnique({
      where: { id: edge.id },
    });
    expect(relived?.deletedAt).toBeNull();
    expect(relived?.deletionId).toBeNull();

    // The host-node undo no longer collides on the relived edge's slot.
    const restored = await testDb.$transaction((tx) =>
      restoreNode(tx, actor, { deletionId: deleted.deletionId }),
    );
    // The edge already detached, so the node-undo does not claim it.
    expect(restored.crossProjectEdgeIds).not.toContain(edge.id);

    // And it remains the single live row in its slot (no double-affect / dup).
    const live = await testDb.crossProjectEdge.count({
      where: { deletedAt: null },
    });
    expect(live).toBe(1);
    const finalEdge = await testDb.crossProjectEdge.findUnique({
      where: { id: edge.id },
    });
    expect(finalEdge?.deletedAt).toBeNull();
    expect(finalEdge?.deletionId).toBeNull();
  });

  it("a host-node undo never revives an independently lone-deleted edge (carve-out)", async () => {
    // Two cross-project edges on the same host node: A is lone-deleted (no
    // deletionId), B is swept by a host-node cascade (deletionId X). Undoing the
    // node restores B but must leave the independently-removed A deleted.
    const { actor, host, hostNode, foreignNode, portal, edge } =
      await seedCrossEdge();
    const edgeA = edge;
    // A second, distinct cross-project edge (different interaction → own slot).
    const edgeB = await connectCrossProject(testDb, actor, {
      hostProjectId: host.id,
      hostNodeId: hostNode.id,
      referenceNodeId: portal.id,
      foreignNodeId: foreignNode.id,
      interaction: "REQUEST",
    });

    // Lone-delete A: deletionId stays null (mirrors deleteEdge).
    await deleteCrossProjectEdge(testDb, actor, { id: edgeA.id });
    const aAfterLoneDelete = await testDb.crossProjectEdge.findUnique({
      where: { id: edgeA.id },
    });
    expect(aAfterLoneDelete?.deletedAt).not.toBeNull();
    expect(aAfterLoneDelete?.deletionId).toBeNull();

    // Cascade-delete the host node, sweeping the still-live B under deletionId X.
    const deleted = await testDb.$transaction((tx) =>
      deleteNode(tx, actor, { id: hostNode.id }),
    );
    expect(deleted.crossProjectEdgeIds).toContain(edgeB.id);
    // A was already a tombstone with no deletionId, so the sweep never claims it.
    expect(deleted.crossProjectEdgeIds).not.toContain(edgeA.id);

    // Undo the node delete: B revives, A stays deleted (the carve-out).
    const restored = await testDb.$transaction((tx) =>
      restoreNode(tx, actor, { deletionId: deleted.deletionId }),
    );
    expect(restored.crossProjectEdgeIds).toContain(edgeB.id);
    expect(restored.crossProjectEdgeIds).not.toContain(edgeA.id);

    const aFinal = await testDb.crossProjectEdge.findUnique({
      where: { id: edgeA.id },
    });
    expect(aFinal?.deletedAt).not.toBeNull();
    const bFinal = await testDb.crossProjectEdge.findUnique({
      where: { id: edgeB.id },
    });
    expect(bFinal?.deletedAt).toBeNull();
  });

  it("restore throws Conflict when a fresh active row now occupies the slot", async () => {
    const { actor, host, hostNode, foreignNode, portal, edge } =
      await seedCrossEdge();

    // Delete the original, then draw an identical (same host+foreign+interaction)
    // edge so the slot is occupied, then try to restore the original.
    await deleteCrossProjectEdge(testDb, actor, { id: edge.id });
    await connectCrossProject(testDb, actor, {
      hostProjectId: host.id,
      hostNodeId: hostNode.id,
      referenceNodeId: portal.id,
      foreignNodeId: foreignNode.id,
    });

    await expect(
      restoreCrossProjectEdge(testDb, actor, { id: edge.id }),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

describe("cross-project edge dedup (#123)", () => {
  it("rejects a second edge with the same host+foreign+interaction (ConflictError)", async () => {
    const { actor, host, hostNode, foreignNode, portal } = await seedCrossEdge();

    await expect(
      connectCrossProject(testDb, actor, {
        hostProjectId: host.id,
        hostNodeId: hostNode.id,
        referenceNodeId: portal.id,
        foreignNodeId: foreignNode.id,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    const live = await testDb.crossProjectEdge.count({
      where: { deletedAt: null },
    });
    expect(live).toBe(1);
  });

  it("allows a second edge with a DIFFERENT interaction (directional slot)", async () => {
    const { actor, host, hostNode, foreignNode, portal } = await seedCrossEdge();

    const second = await connectCrossProject(testDb, actor, {
      hostProjectId: host.id,
      hostNodeId: hostNode.id,
      referenceNodeId: portal.id,
      foreignNodeId: foreignNode.id,
      interaction: "REQUEST",
    });
    expect(second.interaction).toBe("REQUEST");

    const live = await testDb.crossProjectEdge.count({
      where: { deletedAt: null },
    });
    expect(live).toBe(2);
  });

  it("allows recreating after soft-delete (partial index excludes tombstones)", async () => {
    const { actor, host, hostNode, foreignNode, portal, edge } =
      await seedCrossEdge();

    await deleteCrossProjectEdge(testDb, actor, { id: edge.id });
    const recreated = await connectCrossProject(testDb, actor, {
      hostProjectId: host.id,
      hostNodeId: hostNode.id,
      referenceNodeId: portal.id,
      foreignNodeId: foreignNode.id,
    });
    expect(recreated.id).not.toBe(edge.id);
  });
});

describe("deleteNode cascade sweep of cross-project edges (#123)", () => {
  it("sweeps incident cross-project edges on a HOST-NODE delete under the same deletionId; restoreNode revives them", async () => {
    const { actor, hostNode, edge } = await seedCrossEdge();

    const result = await testDb.$transaction((tx) =>
      deleteNode(tx, actor, { id: hostNode.id }),
    );
    expect(result.crossProjectEdgeIds).toContain(edge.id);

    const swept = await testDb.crossProjectEdge.findUnique({
      where: { id: edge.id },
    });
    expect(swept?.deletedAt).not.toBeNull();
    // SAME deletionId as the node batch (the stamped-batch invariant).
    expect(swept?.deletionId).toBe(result.deletionId);

    const restored = await testDb.$transaction((tx) =>
      restoreNode(tx, actor, { deletionId: result.deletionId }),
    );
    expect(restored.crossProjectEdgeIds).toContain(edge.id);
    const revived = await testDb.crossProjectEdge.findUnique({
      where: { id: edge.id },
    });
    expect(revived?.deletedAt).toBeNull();
    expect(revived?.deletionId).toBeNull();
  });

  it("sweeps incident cross-project edges on a PORTAL delete (referenceNode in the subtree)", async () => {
    const { actor, portal, edge } = await seedCrossEdge();

    const result = await testDb.$transaction((tx) =>
      deleteNode(tx, actor, { id: portal.id }),
    );
    expect(result.crossProjectEdgeIds).toContain(edge.id);

    const swept = await testDb.crossProjectEdge.findUnique({
      where: { id: edge.id },
    });
    expect(swept?.deletedAt).not.toBeNull();
    expect(swept?.deletionId).toBe(result.deletionId);
  });
});

describe("getCanvas cross-boundary Go-to fields (#123)", () => {
  it("emits referenceNodeId + foreignParentScopeId on a cross-project proxy", async () => {
    const { actor, host, foreign, hostNode, foreignNode, portal } =
      await seedHostAndForeign();

    // Nest the foreign endpoint under a foreign parent so foreignParentScopeId is
    // a non-null scope (the Canvas the Go-to should land on).
    const foreignParent = await createNode(testDb, actor, {
      projectId: foreign.id,
      title: "Foreign Parent",
    });
    await testDb.node.update({
      where: { id: foreignNode.id },
      data: { parentId: foreignParent.id },
    });

    const edge = await connectCrossProject(testDb, actor, {
      hostProjectId: host.id,
      hostNodeId: hostNode.id,
      referenceNodeId: portal.id,
      foreignNodeId: foreignNode.id,
    });

    const canvas = await getCanvas(testDb, actor, {
      slug: host.slug,
      canvasNodeId: null,
    });
    const proxy = canvas.boundaryProxies.find(
      (p) => p.nodeId === `xproxy_${edge.id}`,
    );
    expect(proxy?.referenceNodeId).toBe(portal.id);
    expect(proxy?.foreignParentScopeId).toBe(foreignParent.id);
    // No foreign project id/slug on the wire — only opaque node ids + title.
    expect(JSON.stringify(canvas)).not.toContain(foreign.slug);
  });

  it("emits foreignParentScopeId === null when the foreign endpoint is at the foreign root", async () => {
    const { actor, host, hostNode, foreignNode, portal } =
      await seedHostAndForeign();
    const edge = await connectCrossProject(testDb, actor, {
      hostProjectId: host.id,
      hostNodeId: hostNode.id,
      referenceNodeId: portal.id,
      foreignNodeId: foreignNode.id,
    });

    const canvas = await getCanvas(testDb, actor, {
      slug: host.slug,
      canvasNodeId: null,
    });
    const proxy = canvas.boundaryProxies.find(
      (p) => p.nodeId === `xproxy_${edge.id}`,
    );
    expect(proxy?.referenceNodeId).toBe(portal.id);
    expect(proxy?.foreignParentScopeId).toBeNull();
  });
});
