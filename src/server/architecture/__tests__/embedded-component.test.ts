import { beforeEach, describe, expect, it } from "vitest";

import { type Actor } from "../actor";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import {
  createEmbeddedComponent,
  createNode,
  getCanvas,
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

  it("annotates an open portal on the host Canvas as embedAccess open", async () => {
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
    expect(portalNode?.embedAccess).toBe("open");
    expect(portalNode?.isPortal).toBe(true);
    // Even an OPEN portal redacts the foreign id — the firewall is uniform.
    expect(
      (portalNode as Record<string, unknown> | undefined)?.embeddedProjectId,
    ).toBeUndefined();
  });
});
