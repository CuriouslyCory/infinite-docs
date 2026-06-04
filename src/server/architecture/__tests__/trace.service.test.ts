import { beforeEach, describe, expect, it } from "vitest";

import { type Actor } from "../actor";
import { ForbiddenError, NotFoundError } from "../errors";
import { createNode } from "../node.service";
import { createProject } from "../project.service";
import { createTrace, deleteTrace } from "../trace.service";
import { resetDb, testDb } from "./helpers/test-db";

beforeEach(async () => {
  await resetDb();
});

function makeUser(name = "Owner") {
  return testDb.user.create({ data: { name } });
}

/**
 * A project owned by `owner` with two live root Components, plus a saved Trace
 * over them. Returns the slug + a non-owner actor so the write-denial tests have
 * something concrete to (fail to) delete.
 */
async function seedProjectWithTrace(ownerId: string) {
  const ownerActor: Actor = { userId: ownerId, via: "session" };
  const project = await createProject(testDb, ownerActor, { title: "System" });
  const a = await createNode(testDb, ownerActor, {
    projectId: project.id,
    title: "A",
    posX: 0,
    posY: 0,
  });
  const b = await createNode(testDb, ownerActor, {
    projectId: project.id,
    title: "B",
    posX: 1,
    posY: 1,
  });
  const trace = await createTrace(testDb, ownerActor, {
    slug: project.slug,
    name: "Path",
    nodeIds: [a.id, b.id],
  });
  return { project, traceId: trace.id, nodeIds: [a.id, b.id] };
}

describe("trace writes — non-disclosure on slug-keyed write (ADR-0040)", () => {
  it("createTrace throws NotFoundError (not Forbidden) for a logged-in non-member of a guestAccess=NONE project", async () => {
    const owner = await makeUser("Owner");
    const stranger = await makeUser("Stranger");
    const { project, nodeIds } = await seedProjectWithTrace(owner.id);
    await testDb.project.update({
      where: { id: project.id },
      data: { guestAccess: "NONE" },
    });

    await expect(
      createTrace(
        testDb,
        { userId: stranger.id },
        { slug: project.slug, name: "Sneaky", nodeIds },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("deleteTrace throws NotFoundError (not Forbidden) for a logged-in non-member of a guestAccess=NONE project", async () => {
    const owner = await makeUser("Owner");
    const stranger = await makeUser("Stranger");
    const { project, traceId } = await seedProjectWithTrace(owner.id);
    await testDb.project.update({
      where: { id: project.id },
      data: { guestAccess: "NONE" },
    });

    await expect(
      deleteTrace(
        testDb,
        { userId: stranger.id },
        { slug: project.slug, traceId },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    const persisted = await testDb.trace.findUnique({ where: { id: traceId } });
    expect(persisted?.deletedAt).toBeNull();
  });

  it("deleteTrace throws ForbiddenError (existence already proven) for a guest-VIEW reader who is not the owner", async () => {
    const owner = await makeUser("Owner");
    const { project, traceId } = await seedProjectWithTrace(owner.id);

    // Default guestAccess is VIEW, so a non-member stranger CAN read this
    // project — having proven it exists, a write-deny discloses nothing new.
    await expect(
      deleteTrace(
        testDb,
        { userId: "stranger" },
        { slug: project.slug, traceId },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const persisted = await testDb.trace.findUnique({ where: { id: traceId } });
    expect(persisted?.deletedAt).toBeNull();
  });
});
