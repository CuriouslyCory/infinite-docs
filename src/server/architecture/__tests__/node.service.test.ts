import { beforeEach, describe, expect, it } from "vitest";

import { type Actor } from "../actor";
import { ForbiddenError, NotFoundError } from "../errors";
import { createNode, getCanvas } from "../node.service";
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

describe("createNode", () => {
  it("persists a Component on the root Canvas with the chosen kind and position", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const project = await makeProject(user.id);

    const node = await createNode(testDb, actor, {
      projectId: project.id,
      kind: "DATABASE",
      title: "Postgres",
      posX: 120,
      posY: 40,
    });

    expect(node.projectId).toBe(project.id);
    expect(node.parentId).toBeNull();
    expect(node.kind).toBe("DATABASE");
    expect(node.title).toBe("Postgres");
    expect(node.posX).toBe(120);
    expect(node.posY).toBe(40);
    expect(node.deletedAt).toBeNull();

    const persisted = await testDb.node.findUnique({ where: { id: node.id } });
    expect(persisted?.projectId).toBe(project.id);
  });

  it("rejects a non-owner attempting to add a Component (the project handle is not a write grant)", async () => {
    const owner = await makeUser("Owner");
    const project = await makeProject(owner.id);
    const intruder: Actor = { userId: "intruder" };

    await expect(
      createNode(testDb, intruder, { projectId: project.id, kind: "SERVICE" }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const count = await testDb.node.count({
      where: { projectId: project.id },
    });
    expect(count).toBe(0);
  });

  it("reports not-found for an unknown project", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };

    await expect(
      createNode(testDb, actor, { projectId: "nope", kind: "GENERIC" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("getCanvas", () => {
  it("returns the interior Components of the root Canvas without an actor (slug is the read grant)", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const project = await makeProject(user.id);
    await createNode(testDb, actor, {
      projectId: project.id,
      kind: "SERVICE",
      title: "A",
    });
    await createNode(testDb, actor, {
      projectId: project.id,
      kind: "DATABASE",
      title: "B",
    });

    const canvas = await getCanvas(testDb, null, { slug: project.slug });

    expect(canvas.interiorNodes.map((n) => n.title).sort()).toEqual(["A", "B"]);
  });

  it("omits soft-deleted Components", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const project = await makeProject(user.id);
    const kept = await createNode(testDb, actor, {
      projectId: project.id,
      title: "Kept",
    });
    const doomed = await createNode(testDb, actor, {
      projectId: project.id,
      title: "Doomed",
    });
    await testDb.node.update({
      where: { id: doomed.id },
      data: { deletedAt: new Date() },
    });

    const canvas = await getCanvas(testDb, null, { slug: project.slug });

    expect(canvas.interiorNodes.map((n) => n.id)).toEqual([kept.id]);
  });

  it("never returns Components from another project", async () => {
    const owner = await makeUser();
    const actor: Actor = { userId: owner.id, via: "session" };
    const projectA = await makeProject(owner.id, "A");
    const projectB = await makeProject(owner.id, "B");
    await createNode(testDb, actor, { projectId: projectA.id, title: "in-A" });
    await createNode(testDb, actor, { projectId: projectB.id, title: "in-B" });

    const canvas = await getCanvas(testDb, null, { slug: projectA.slug });

    expect(canvas.interiorNodes.map((n) => n.title)).toEqual(["in-A"]);
  });

  it("does not return interior (child) Components in the root Canvas", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const project = await makeProject(user.id);
    const parent = await createNode(testDb, actor, {
      projectId: project.id,
      title: "Parent",
    });
    // Plant a child directly: the public create-child API arrives in a later
    // slice (#8), but the scope filter must already exclude it from the root.
    await testDb.node.create({
      data: { projectId: project.id, parentId: parent.id, title: "Child" },
    });

    const canvas = await getCanvas(testDb, null, { slug: project.slug });

    expect(canvas.interiorNodes.map((n) => n.title)).toEqual(["Parent"]);
  });

  it("returns the interior Components of a given (non-root) scope", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const project = await makeProject(user.id);
    const parent = await createNode(testDb, actor, {
      projectId: project.id,
      title: "Parent",
    });
    const child = await testDb.node.create({
      data: { projectId: project.id, parentId: parent.id, title: "Child" },
    });

    const canvas = await getCanvas(testDb, null, {
      slug: project.slug,
      canvasNodeId: parent.id,
    });

    expect(canvas.interiorNodes.map((n) => n.id)).toEqual([child.id]);
  });
});
