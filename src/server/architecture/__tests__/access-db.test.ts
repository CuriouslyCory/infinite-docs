import { beforeEach, describe, expect, it } from "vitest";

import { batchRegateReadable } from "../access-db";
import { type Actor } from "../actor";
import { createProject } from "../project.service";
import { resetDb, testDb } from "./helpers/test-db";

beforeEach(async () => {
  await resetDb();
});

function makeUser(name = "User") {
  return testDb.user.create({ data: { name } });
}

async function makeProject(ownerId: string, title = "Project") {
  return createProject(testDb, { userId: ownerId }, { title });
}

/** Closes a project to members-only (guestAccess=NONE) so a non-member cannot read it. */
async function closeProject(projectId: string) {
  await testDb.project.update({
    where: { id: projectId },
    data: { guestAccess: "NONE" },
  });
}

describe("batchRegateReadable", () => {
  it("readable — owner resolves capability 'owner'", async () => {
    const user = await makeUser("Owner");
    const actor: Actor = { userId: user.id, via: "session" };
    const project = await makeProject(user.id);
    await closeProject(project.id); // even a closed project is readable by its owner

    const { readable, withheld } = await batchRegateReadable(testDb, actor, [
      project.id,
    ]);

    expect(readable.get(project.id)).toBe("owner");
    expect(withheld.size).toBe(0);
  });

  it("readable — guest-VIEW non-member resolves capability 'view'", async () => {
    const owner = await makeUser("Owner");
    const stranger = await makeUser("Stranger");
    const actor: Actor = { userId: stranger.id, via: "session" };
    // createProject defaults guestAccess=VIEW → any actor reads at 'view'.
    const project = await makeProject(owner.id);

    const { readable, withheld } = await batchRegateReadable(testDb, actor, [
      project.id,
    ]);

    expect(readable.get(project.id)).toBe("view");
    expect(withheld.size).toBe(0);
  });

  it("readable — member EDITOR on a NONE project resolves capability 'edit'", async () => {
    const owner = await makeUser("Owner");
    const member = await makeUser("Member");
    const actor: Actor = { userId: member.id, via: "session" };
    const project = await makeProject(owner.id);
    await closeProject(project.id); // guestAccess=NONE → only membership grants access
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: member.id, role: "EDITOR" },
    });

    const { readable, withheld } = await batchRegateReadable(testDb, actor, [
      project.id,
    ]);

    expect(readable.get(project.id)).toBe("edit");
    expect(withheld.size).toBe(0);
  });

  it("withheld — stranger to a NONE project (deny is non-disclosed)", async () => {
    const owner = await makeUser("Owner");
    const stranger = await makeUser("Stranger");
    const actor: Actor = { userId: stranger.id, via: "session" };
    const project = await makeProject(owner.id);
    await closeProject(project.id);

    const { readable, withheld } = await batchRegateReadable(testDb, actor, [
      project.id,
    ]);

    expect(withheld.has(project.id)).toBe(true);
    expect(readable.has(project.id)).toBe(false);
  });

  it("withheld — soft-deleted project", async () => {
    const owner = await makeUser("Owner");
    const actor: Actor = { userId: owner.id, via: "session" };
    const project = await makeProject(owner.id);
    await testDb.project.update({
      where: { id: project.id },
      data: { deletedAt: new Date() },
    });

    const { readable, withheld } = await batchRegateReadable(testDb, actor, [
      project.id,
    ]);

    expect(withheld.has(project.id)).toBe(true);
    expect(readable.has(project.id)).toBe(false);
  });

  it("withheld — dangling / missing UUID", async () => {
    const owner = await makeUser("Owner");
    const actor: Actor = { userId: owner.id, via: "session" };
    const missingId = "00000000-0000-0000-0000-000000000000";

    const { readable, withheld } = await batchRegateReadable(testDb, actor, [
      missingId,
    ]);

    expect(withheld.has(missingId)).toBe(true);
    expect(readable.has(missingId)).toBe(false);
  });

  it("dedupes — [id, id, id] yields a single readable entry", async () => {
    const user = await makeUser("Owner");
    const actor: Actor = { userId: user.id, via: "session" };
    const project = await makeProject(user.id);

    const { readable, withheld } = await batchRegateReadable(testDb, actor, [
      project.id,
      project.id,
      project.id,
    ]);

    expect(readable.size).toBe(1);
    expect(readable.get(project.id)).toBe("owner");
    expect(withheld.size).toBe(0);
  });

  it("mixed — partitions distinct input into readable and withheld", async () => {
    const owner = await makeUser("Owner");
    const stranger = await makeUser("Stranger");
    const actor: Actor = { userId: stranger.id, via: "session" };
    const readableProject = await makeProject(owner.id, "Open"); // guestAccess=VIEW
    const closedProject = await makeProject(owner.id, "Closed");
    await closeProject(closedProject.id);
    const missingId = "00000000-0000-0000-0000-000000000000";

    const { readable, withheld } = await batchRegateReadable(testDb, actor, [
      readableProject.id,
      closedProject.id,
      missingId,
    ]);

    expect(readable.get(readableProject.id)).toBe("view");
    expect(readable.has(closedProject.id)).toBe(false);
    expect(readable.has(missingId)).toBe(false);
    expect(withheld.has(closedProject.id)).toBe(true);
    expect(withheld.has(missingId)).toBe(true);
    expect(withheld.has(readableProject.id)).toBe(false);
  });

  it("empty input — returns empty Map and Set without throwing", async () => {
    const user = await makeUser("Owner");
    const actor: Actor = { userId: user.id, via: "session" };

    const { readable, withheld } = await batchRegateReadable(testDb, actor, []);

    expect(readable.size).toBe(0);
    expect(withheld.size).toBe(0);
  });

  it("anonymous actor — VIEW project readable, NONE project withheld", async () => {
    const owner = await makeUser("Owner");
    const openProject = await makeProject(owner.id, "Open"); // guestAccess=VIEW
    const closedProject = await makeProject(owner.id, "Closed");
    await closeProject(closedProject.id);

    const { readable, withheld } = await batchRegateReadable(testDb, null, [
      openProject.id,
      closedProject.id,
    ]);

    expect(readable.get(openProject.id)).toBe("view");
    expect(withheld.has(closedProject.id)).toBe(true);
    expect(readable.has(closedProject.id)).toBe(false);
  });

  it("indistinguishability — deny, soft-deleted, missing, and dangling all collapse identically into withheld", async () => {
    const owner = await makeUser("Owner");
    const stranger = await makeUser("Stranger");
    const actor: Actor = { userId: stranger.id, via: "session" };

    // (1) deny — stranger to a NONE project
    const denied = await makeProject(owner.id, "Denied");
    await closeProject(denied.id);
    // (2) soft-deleted — was readable (VIEW) but now deletedAt is set
    const softDeleted = await makeProject(owner.id, "SoftDeleted");
    await testDb.project.update({
      where: { id: softDeleted.id },
      data: { deletedAt: new Date() },
    });
    // (3) missing — a never-existed UUID
    const missingId = "11111111-1111-1111-1111-111111111111";
    // (4) dangling — a syntactically valid id with no row (same shape as missing,
    // modeling a foreign FK whose project was hard-removed)
    const danglingId = "22222222-2222-2222-2222-222222222222";

    const { readable, withheld } = await batchRegateReadable(testDb, actor, [
      denied.id,
      softDeleted.id,
      missingId,
      danglingId,
    ]);

    // All four land in withheld; none leak a capability into readable. The seam
    // never surfaces WHY — the four reasons are indistinguishable on the wire.
    expect(readable.size).toBe(0);
    for (const id of [denied.id, softDeleted.id, missingId, danglingId]) {
      expect(withheld.has(id)).toBe(true);
      expect(readable.has(id)).toBe(false);
    }
  });
});
