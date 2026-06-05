import { beforeEach, describe, expect, it } from "vitest";

import { type Actor } from "../actor";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { connectNodes } from "../edge.service";
import {
  createEmbeddedComponent,
  createNode,
  getCanvas,
  moveNode,
  updatePositions,
  upsertBoundaryProxyPlacement,
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

/** Closes a project to members-only (guestAccess=NONE) so a non-member cannot read it. */
async function closeProject(projectId: string) {
  await testDb.project.update({
    where: { id: projectId },
    data: { guestAccess: "NONE" },
  });
}

describe("createEmbeddedComponent", () => {
  it("embeds an owned target the actor can read", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const host = await makeProject(user.id, "Host");
    const target = await makeProject(user.id, "Target");

    const portal = await createEmbeddedComponent(testDb, actor, {
      projectId: host.id,
      embeddedProjectId: target.id,
      title: "Embedded Target",
    });

    expect(portal.embeddedProjectId).toBe(target.id);
    expect(portal.projectId).toBe(host.id);
    const persisted = await testDb.node.findUnique({
      where: { id: portal.id },
    });
    expect(persisted?.embeddedProjectId).toBe(target.id);
  });

  it("throws Forbidden when the actor lacks host edit (gated BEFORE the target read)", async () => {
    const owner = await makeUser("Owner");
    const intruder = await makeUser("Intruder");
    const ownerActor: Actor = { userId: owner.id, via: "session" };
    const intruderActor: Actor = { userId: intruder.id, via: "session" };
    const host = await makeProject(owner.id, "Host");
    // The intruder owns the target, so a missing-host-edit denial cannot be the
    // target read failing — it must be the host write gate, and it must be Forbidden.
    const target = await makeProject(intruder.id, "Intruder Target");

    await expect(
      createEmbeddedComponent(testDb, intruderActor, {
        projectId: host.id,
        embeddedProjectId: target.id,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // No portal was written.
    const count = await testDb.node.count({
      where: { projectId: host.id },
    });
    expect(count).toBe(0);
    void ownerActor;
  });

  it("throws NotFound when the target is unreadable (embed only what you can read)", async () => {
    const owner = await makeUser("Owner");
    const stranger = await makeUser("Stranger");
    const ownerActor: Actor = { userId: owner.id, via: "session" };
    const host = await makeProject(owner.id, "Host");
    // A stranger's NONE project the owner is not a member of → unreadable.
    const target = await makeProject(stranger.id, "Private Target");
    await closeProject(target.id);

    await expect(
      createEmbeddedComponent(testDb, ownerActor, {
        projectId: host.id,
        embeddedProjectId: target.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a self-embed with a ValidationError", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const host = await makeProject(user.id, "Host");

    await expect(
      createEmbeddedComponent(testDb, actor, {
        projectId: host.id,
        embeddedProjectId: host.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("getCanvas through a Project Portal", () => {
  it("returns the embedded project's interior when the actor can read the target", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const host = await makeProject(user.id, "Host");
    const target = await makeProject(user.id, "Target");
    // Seed a Component in the TARGET's root so we can prove we cross into it.
    await createNode(testDb, actor, {
      projectId: target.id,
      title: "Inside Target",
    });
    const portal = await createEmbeddedComponent(testDb, actor, {
      projectId: host.id,
      embeddedProjectId: target.id,
      title: "Portal",
    });

    const canvas = await getCanvas(testDb, actor, {
      slug: host.slug,
      canvasNodeId: null,
      embedPath: [portal.id],
    });

    expect(canvas.activeProject.id).toBe(target.id);
    expect(canvas.interiorNodes.map((n) => n.title)).toEqual(["Inside Target"]);
    expect(canvas.embedTrail.map((p) => p.id)).toEqual([portal.id]);
  });

  it("HEADLINE: host owner with no foreign grant gets NotFound at the crossing (locked portal)", async () => {
    const hostOwner = await makeUser("Host Owner");
    const targetOwner = await makeUser("Target Owner");
    const hostActor: Actor = { userId: hostOwner.id, via: "session" };
    const targetActor: Actor = { userId: targetOwner.id, via: "session" };
    const host = await makeProject(hostOwner.id, "Host");
    const target = await makeProject(targetOwner.id, "Private Target");

    // The target owner embeds their OWN project into the host (they have host
    // edit too — grant a membership so they can write the host).
    await testDb.projectMembership.create({
      data: { projectId: host.id, userId: targetOwner.id, role: "EDITOR" },
    });
    const portal = await createEmbeddedComponent(testDb, targetActor, {
      projectId: host.id,
      embeddedProjectId: target.id,
      title: "Portal",
    });
    // Now close the target so only its owner can read it.
    await closeProject(target.id);

    // The HOST owner — who can read the host and its portal Node — still cannot
    // cross into the closed foreign project: the crossing re-gate collapses to
    // NotFound, never disclosing the foreign project's existence.
    await expect(
      getCanvas(testDb, hostActor, {
        slug: host.slug,
        canvasNodeId: null,
        embedPath: [portal.id],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // And on the host's OWN Canvas the portal Node is annotated `locked` for the
    // host owner (the No-access pill), again without leaking the target.
    const hostCanvas = await getCanvas(testDb, hostActor, {
      slug: host.slug,
      canvasNodeId: null,
    });
    const portalNode = hostCanvas.interiorNodes.find((n) => n.id === portal.id);
    expect(portalNode?.embedAccess).toBe("locked");
    // The host owner held no foreign grant from the start — they never knew the
    // target's title, so a locked portal must carry the neutral sentinel, not the
    // captured foreign title.
    expect(portalNode?.title).toBe("Locked project");
    // Non-disclosure firewall (the headline property): the locked portal Node MUST
    // carry only the non-identifying `isPortal` boolean — the foreign Project.id is
    // redacted from the wire entirely, so a host owner with no grant never learns
    // WHICH project the portal targets.
    expect(portalNode?.isPortal).toBe(true);
    expect(
      (portalNode as Record<string, unknown> | undefined)?.embeddedProjectId,
    ).toBeUndefined();

    // The target owner crosses fine (open).
    const targetView = await getCanvas(testDb, targetActor, {
      slug: host.slug,
      canvasNodeId: null,
      embedPath: [portal.id],
    });
    expect(targetView.activeProject.id).toBe(target.id);
  });

  it("collapses a forged/stale via chain to NotFound", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const host = await makeProject(user.id, "Host");
    // A non-portal Node in the host (no embeddedProjectId).
    const plain = await createNode(testDb, actor, {
      projectId: host.id,
      title: "Plain",
    });

    // Forged: a Node id that is not a portal.
    await expect(
      getCanvas(testDb, actor, {
        slug: host.slug,
        canvasNodeId: null,
        embedPath: [plain.id],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Forged: an id that does not exist at all.
    await expect(
      getCanvas(testDb, actor, {
        slug: host.slug,
        canvasNodeId: null,
        embedPath: ["does-not-exist"],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    // Forged via a REAL portal whose target the actor cannot read: a genuine portal
    // id (so it is NOT the "not a portal" path above) pointing at a separate owner's
    // closed project. The walk's per-crossing re-gate (node.service ~455) must still
    // collapse to NotFound — pinning that re-gate independently of the host-Canvas
    // annotation path.
    const targetOwner = await makeUser("Forged Target Owner");
    const targetActor: Actor = { userId: targetOwner.id, via: "session" };
    const closedTarget = await makeProject(targetOwner.id, "Closed Target");
    // Grant the target owner host edit so they can place the (legitimate) portal.
    await testDb.projectMembership.create({
      data: { projectId: host.id, userId: targetOwner.id, role: "EDITOR" },
    });
    const realPortal = await createEmbeddedComponent(testDb, targetActor, {
      projectId: host.id,
      embeddedProjectId: closedTarget.id,
      title: "Real Portal",
    });
    await closeProject(closedTarget.id);

    await expect(
      getCanvas(testDb, actor, {
        slug: host.slug,
        canvasNodeId: null,
        embedPath: [realPortal.id],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("annotates an owner-on-target portal on the host Canvas as embedAccess enterable", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const host = await makeProject(user.id, "Host");
    const target = await makeProject(user.id, "Target");
    const portal = await createEmbeddedComponent(testDb, actor, {
      projectId: host.id,
      embeddedProjectId: target.id,
      title: "Portal",
    });

    const canvas = await getCanvas(testDb, actor, { slug: host.slug });
    const portalNode = canvas.interiorNodes.find((n) => n.id === portal.id);
    // The actor OWNS the target (≥ edit) → enterable.
    expect(portalNode?.embedAccess).toBe("enterable");
    expect(portalNode?.isPortal).toBe(true);
    // Even an enterable portal redacts the foreign id — the firewall is uniform.
    expect(
      (portalNode as Record<string, unknown> | undefined)?.embeddedProjectId,
    ).toBeUndefined();
  });

  it("annotates a VIEWER-shared target as embedAccess readOnly (foreign id withheld)", async () => {
    const hostOwner = await makeUser("Host Owner");
    const targetOwner = await makeUser("Target Owner");
    const hostActor: Actor = { userId: hostOwner.id, via: "session" };
    const targetActor: Actor = { userId: targetOwner.id, via: "session" };
    const host = await makeProject(hostOwner.id, "Host");
    const target = await makeProject(targetOwner.id, "Shared Target");
    await closeProject(target.id);

    // The target owner places the portal (host EDITOR), then shares the target with
    // the host owner as a VIEWER — exactly `view`, not enough to enter.
    await testDb.projectMembership.create({
      data: { projectId: host.id, userId: targetOwner.id, role: "EDITOR" },
    });
    const portal = await createEmbeddedComponent(testDb, targetActor, {
      projectId: host.id,
      embeddedProjectId: target.id,
      title: "Portal",
    });
    await testDb.projectMembership.create({
      data: { projectId: target.id, userId: hostOwner.id, role: "VIEWER" },
    });

    const canvas = await getCanvas(testDb, hostActor, { slug: host.slug });
    const portalNode = canvas.interiorNodes.find((n) => n.id === portal.id);
    expect(portalNode?.embedAccess).toBe("readOnly");
    expect(portalNode?.isPortal).toBe(true);
    expect(
      (portalNode as Record<string, unknown> | undefined)?.embeddedProjectId,
    ).toBeUndefined();
  });

  it("lets a VIEWER-shared actor descend into the foreign scope (read-only)", async () => {
    const hostOwner = await makeUser("Host Owner");
    const targetOwner = await makeUser("Target Owner");
    const hostActor: Actor = { userId: hostOwner.id, via: "session" };
    const targetActor: Actor = { userId: targetOwner.id, via: "session" };
    const host = await makeProject(hostOwner.id, "Host");
    const target = await makeProject(targetOwner.id, "Shared Target");
    await closeProject(target.id);
    await createNode(testDb, targetActor, {
      projectId: target.id,
      title: "Inside Target",
    });

    await testDb.projectMembership.create({
      data: { projectId: host.id, userId: targetOwner.id, role: "EDITOR" },
    });
    const portal = await createEmbeddedComponent(testDb, targetActor, {
      projectId: host.id,
      embeddedProjectId: target.id,
      title: "Portal",
    });
    await testDb.projectMembership.create({
      data: { projectId: target.id, userId: hostOwner.id, role: "VIEWER" },
    });

    // The host owner holds only `view` on the target, but `view` is enough to
    // descend — the crossing re-gate resolves (no throw) and lands in the foreign
    // scope; the route shell forces read-only above the service.
    const canvas = await getCanvas(testDb, hostActor, {
      slug: host.slug,
      canvasNodeId: null,
      embedPath: [portal.id],
    });
    expect(canvas.activeProject.id).toBe(target.id);
    expect(canvas.interiorNodes.map((n) => n.title)).toEqual(["Inside Target"]);
  });

  it("renders a revoked portal as locked WITHOUT disclosing the foreign title", async () => {
    const hostOwner = await makeUser("Host Owner");
    const targetOwner = await makeUser("Target Owner");
    const hostActor: Actor = { userId: hostOwner.id, via: "session" };
    const targetActor: Actor = { userId: targetOwner.id, via: "session" };
    const host = await makeProject(hostOwner.id, "Host");
    // A distinctive title we assert is ABSENT from the locked sentinel.
    const target = await makeProject(targetOwner.id, "Secret Service Name");
    await closeProject(target.id);

    await testDb.projectMembership.create({
      data: { projectId: host.id, userId: targetOwner.id, role: "EDITOR" },
    });
    const portal = await createEmbeddedComponent(testDb, targetActor, {
      projectId: host.id,
      embeddedProjectId: target.id,
      title: "Secret Service Name",
    });
    // Grant the host owner VIEW, then REVOKE it — access is now `none` on a closed
    // target. The portal node still legitimately exists on the host, so the host
    // read returns a locked sentinel (not NotFound).
    const membership = await testDb.projectMembership.create({
      data: { projectId: target.id, userId: hostOwner.id, role: "VIEWER" },
    });
    await testDb.projectMembership.delete({ where: { id: membership.id } });

    const canvas = await getCanvas(testDb, hostActor, { slug: host.slug });
    const portalNode = canvas.interiorNodes.find((n) => n.id === portal.id);
    expect(portalNode?.embedAccess).toBe("locked");
    expect(portalNode?.isPortal).toBe(true);
    // The captured foreign title MUST NOT reach the wire — the sentinel replaces it.
    expect(portalNode?.title).toBe("Locked project");
    expect(portalNode?.title).not.toBe("Secret Service Name");
    expect(
      (portalNode as Record<string, unknown> | undefined)?.embeddedProjectId,
    ).toBeUndefined();
  });

  it("renders a revoked portal's BOUNDARY PROXY as locked WITHOUT disclosing the foreign title", async () => {
    const hostOwner = await makeUser("Host Owner");
    const targetOwner = await makeUser("Target Owner");
    const hostActor: Actor = { userId: hostOwner.id, via: "session" };
    const targetActor: Actor = { userId: targetOwner.id, via: "session" };
    const host = await makeProject(hostOwner.id, "Host");
    // The distinctive foreign title we assert is ABSENT from the locked proxy.
    const target = await makeProject(targetOwner.id, "Secret Service Name");
    await closeProject(target.id);

    // The target owner (host EDITOR) embeds their own project as a portal at the
    // host ROOT — the portal's stored title is the foreign project's title.
    await testDb.projectMembership.create({
      data: { projectId: host.id, userId: targetOwner.id, role: "EDITOR" },
    });
    const portal = await createEmbeddedComponent(testDb, targetActor, {
      projectId: host.id,
      embeddedProjectId: target.id,
      title: "Secret Service Name",
    });

    // A nested host node (`inside`, child of `parent`) connected to the portal at
    // root. Viewing `parent`'s Canvas leaves the portal OFF-SCOPE, so it surfaces as
    // a BOUNDARY PROXY — the exact path the interior-node locking never touched.
    const parent = await createNode(testDb, hostActor, {
      projectId: host.id,
      title: "Parent",
    });
    const inside = await createNode(testDb, hostActor, {
      projectId: host.id,
      parentId: parent.id,
      title: "Inside",
    });
    const edge = await connectNodes(testDb, hostActor, {
      projectId: host.id,
      sourceId: inside.id,
      targetId: portal.id,
    });

    // Grant the host owner VIEW on the target, then REVOKE it — access is now `none`.
    const membership = await testDb.projectMembership.create({
      data: { projectId: target.id, userId: hostOwner.id, role: "VIEWER" },
    });
    await testDb.projectMembership.delete({ where: { id: membership.id } });

    const canvas = await getCanvas(testDb, hostActor, {
      slug: host.slug,
      canvasNodeId: parent.id,
    });

    const proxy = canvas.boundaryProxies.find(
      (p) => p.realEndpointId === portal.id,
    );
    expect(proxy).toBeDefined();
    // The captured foreign title MUST NOT reach the wire via the proxy path either.
    expect(proxy?.title).toBe("Locked project");
    expect(proxy?.title).not.toBe("Secret Service Name");
    // The proxy never carries the foreign embedded project id.
    expect(
      (proxy as Record<string, unknown> | undefined)?.embeddedProjectId,
    ).toBeUndefined();
    void edge;
  });

  it("lets an EDITOR-on-host / VIEWER-on-target actor create the embed", async () => {
    const hostOwner = await makeUser("Host Owner");
    const actorUser = await makeUser("Editor+Viewer");
    const targetOwner = await makeUser("Target Owner");
    const actor: Actor = { userId: actorUser.id, via: "session" };
    const host = await makeProject(hostOwner.id, "Host");
    const target = await makeProject(targetOwner.id, "Shared Target");
    await closeProject(target.id);

    // EDITOR on the host (≥ edit → may write the portal), VIEWER on the target
    // (≥ view → may embed it). The widened gate must permit this.
    await testDb.projectMembership.create({
      data: { projectId: host.id, userId: actorUser.id, role: "EDITOR" },
    });
    await testDb.projectMembership.create({
      data: { projectId: target.id, userId: actorUser.id, role: "VIEWER" },
    });

    const portal = await createEmbeddedComponent(testDb, actor, {
      projectId: host.id,
      embeddedProjectId: target.id,
      title: "Embedded Shared",
    });

    expect(portal.embeddedProjectId).toBe(target.id);
    const persisted = await testDb.node.findUnique({
      where: { id: portal.id },
    });
    expect(persisted?.embeddedProjectId).toBe(target.id);
  });
});

describe("portal-interior guard (#121)", () => {
  it("rejects createNode whose parent is a portal Component", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const host = await makeProject(user.id, "Host");
    const target = await makeProject(user.id, "Target");
    const portal = await createEmbeddedComponent(testDb, actor, {
      projectId: host.id,
      embeddedProjectId: target.id,
      title: "Portal",
    });

    // A portal has no host interior — a child can never hang off it.
    await expect(
      createNode(testDb, actor, {
        projectId: host.id,
        parentId: portal.id,
        title: "Illegal Child",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Nothing was written under the portal.
    const childCount = await testDb.node.count({
      where: { parentId: portal.id },
    });
    expect(childCount).toBe(0);
  });

  it("rejects moveNode onto a portal Component", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const host = await makeProject(user.id, "Host");
    const target = await makeProject(user.id, "Target");
    const portal = await createEmbeddedComponent(testDb, actor, {
      projectId: host.id,
      embeddedProjectId: target.id,
      title: "Portal",
    });
    const movable = await createNode(testDb, actor, {
      projectId: host.id,
      title: "Movable",
    });

    await expect(
      moveNode(testDb, actor, { id: movable.id, parentId: portal.id }),
    ).rejects.toBeInstanceOf(ValidationError);

    // The move was rejected before any reparent — the node stays at the root.
    const persisted = await testDb.node.findUnique({
      where: { id: movable.id },
    });
    expect(persisted?.parentId).toBeNull();
  });

  it("rejects createEmbeddedComponent whose parent is a portal Component", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const host = await makeProject(user.id, "Host");
    const target = await makeProject(user.id, "Target");
    const other = await makeProject(user.id, "Other");
    const portal = await createEmbeddedComponent(testDb, actor, {
      projectId: host.id,
      embeddedProjectId: target.id,
      title: "Portal",
    });

    // A portal has no host interior — placing ANOTHER portal under it
    // (portal-under-portal) is the same invariant violation as a plain child.
    await expect(
      createEmbeddedComponent(testDb, actor, {
        projectId: host.id,
        embeddedProjectId: other.id,
        parentId: portal.id,
        title: "Nested Portal",
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    // Nothing was written under the portal.
    const childCount = await testDb.node.count({
      where: { parentId: portal.id },
    });
    expect(childCount).toBe(0);
  });
});

describe("edit-through a Project Portal (#121)", () => {
  /**
   * Shared setup: an actor who is HOST EDITOR and holds some role on the TARGET,
   * with a portal placed at the host root. Returns everything a write-through
   * test needs to drive the foreign scope.
   */
  async function seedPortal(targetRole: "EDITOR" | "VIEWER") {
    const hostOwner = await makeUser("Host Owner");
    const targetOwner = await makeUser("Target Owner");
    const actorUser = await makeUser("Through Actor");
    const targetActor: Actor = { userId: targetOwner.id, via: "session" };
    const actor: Actor = { userId: actorUser.id, via: "session" };
    const host = await makeProject(hostOwner.id, "Host");
    const target = await makeProject(targetOwner.id, "Target");
    await closeProject(target.id);

    // The target owner places the portal (granted host EDITOR to write it).
    await testDb.projectMembership.create({
      data: { projectId: host.id, userId: targetOwner.id, role: "EDITOR" },
    });
    const portal = await createEmbeddedComponent(testDb, targetActor, {
      projectId: host.id,
      embeddedProjectId: target.id,
      title: "Portal",
    });

    // The through-actor is host EDITOR + the requested role on the target.
    await testDb.projectMembership.create({
      data: { projectId: host.id, userId: actorUser.id, role: "EDITOR" },
    });
    await testDb.projectMembership.create({
      data: { projectId: target.id, userId: actorUser.id, role: targetRole },
    });

    return { actor, host, target, portal };
  }

  it("lets an EDITOR-on-target create through the portal — persists to the target, visible standalone", async () => {
    const { actor, host, target, portal } = await seedPortal("EDITOR");

    // The write addresses the FOREIGN project id (what the island sends once
    // descended), authorized against the target's EDITOR grant.
    const created = await createNode(testDb, actor, {
      projectId: target.id,
      title: "Made Through Portal",
    });
    expect(created.projectId).toBe(target.id);

    // It is real in the target — opening the target standalone shows it.
    const targetStandalone = await getCanvas(testDb, actor, {
      slug: target.slug,
      canvasNodeId: null,
    });
    expect(targetStandalone.interiorNodes.map((n) => n.title)).toContain(
      "Made Through Portal",
    );

    // And it shows when descending through the host's portal too.
    const through = await getCanvas(testDb, actor, {
      slug: host.slug,
      canvasNodeId: null,
      embedPath: [portal.id],
    });
    expect(through.activeProject.id).toBe(target.id);
    expect(through.interiorNodes.map((n) => n.title)).toContain(
      "Made Through Portal",
    );
  });

  it("denies a VIEWER-on-target write through the portal (createNode) with Forbidden", async () => {
    const { actor, target } = await seedPortal("VIEWER");

    await expect(
      createNode(testDb, actor, {
        projectId: target.id,
        title: "Should Be Denied",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const count = await testDb.node.count({ where: { projectId: target.id } });
    expect(count).toBe(0);
  });

  it("denies a VIEWER-on-target connect/position write through the portal with Forbidden", async () => {
    const { actor, target } = await seedPortal("VIEWER");
    // Seed two nodes in the target as its owner so there is something to write.
    const { ownerId } = await testDb.project.findUniqueOrThrow({
      where: { id: target.id },
      select: { ownerId: true },
    });
    const ownerActor: Actor = { userId: ownerId, via: "session" };
    const a = await createNode(testDb, ownerActor, {
      projectId: target.id,
      title: "A",
    });
    const b = await createNode(testDb, ownerActor, {
      projectId: target.id,
      title: "B",
    });

    // A VIEWER's connect is denied.
    await expect(
      connectNodes(testDb, actor, {
        projectId: target.id,
        sourceId: a.id,
        targetId: b.id,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // A VIEWER's position write is denied too.
    await expect(
      updatePositions(testDb, actor, {
        projectId: target.id,
        positions: [{ id: a.id, posX: 10, posY: 20 }],
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // And a VIEWER's boundary-proxy placement write — the sixth project-id-keyed
    // write through the portal — is denied on the host-edit gate too.
    await expect(
      upsertBoundaryProxyPlacement(testDb, actor, {
        projectId: target.id,
        containerNodeId: null,
        realEndpointId: a.id,
        posX: 10,
        posY: 20,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("activeProject.canEdit: owner descending own portal → true", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const host = await makeProject(user.id, "Host");
    const target = await makeProject(user.id, "Target");
    const portal = await createEmbeddedComponent(testDb, actor, {
      projectId: host.id,
      embeddedProjectId: target.id,
      title: "Portal",
    });

    // Host root: the actor owns the host → canEdit true.
    const hostCanvas = await getCanvas(testDb, actor, {
      slug: host.slug,
      canvasNodeId: null,
    });
    expect(hostCanvas.activeProject.canEdit).toBe(true);

    // Descended into the target the actor also owns → still true.
    const through = await getCanvas(testDb, actor, {
      slug: host.slug,
      canvasNodeId: null,
      embedPath: [portal.id],
    });
    expect(through.activeProject.id).toBe(target.id);
    expect(through.activeProject.canEdit).toBe(true);
  });

  it("activeProject.canEdit: viewer-shared descend → false", async () => {
    const { actor, host, target, portal } = await seedPortal("VIEWER");

    const through = await getCanvas(testDb, actor, {
      slug: host.slug,
      canvasNodeId: null,
      embedPath: [portal.id],
    });
    expect(through.activeProject.id).toBe(target.id);
    // The actor holds only `view` on the target → edit-through is denied.
    expect(through.activeProject.canEdit).toBe(false);
  });
});
