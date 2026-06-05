import { beforeEach, describe, expect, it } from "vitest";

import { type Actor } from "../actor";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { connectCrossProject } from "../edge.service";
import {
  createEmbeddedComponent,
  createNode,
  getCanvas,
  listForeignComponentsViaPortal,
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
