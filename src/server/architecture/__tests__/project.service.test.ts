import { beforeEach, describe, expect, it } from "vitest";

import { assertCanWrite } from "../access";
import { type Actor } from "../actor";
import { ForbiddenError, NotFoundError } from "../errors";
import {
  createProject,
  getProjectBySlug,
  listProjects,
} from "../project.service";
import { resetDb, testDb } from "./helpers/test-db";

beforeEach(async () => {
  await resetDb();
});

function makeUser(name = "Owner") {
  return testDb.user.create({ data: { name } });
}

describe("createProject", () => {
  it("creates a project owned by the actor with an unguessable slug", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };

    const project = await createProject(testDb, actor, { title: "My System" });

    expect(project.title).toBe("My System");
    expect(project.ownerId).toBe(user.id);
    expect(project.slug).toMatch(/^[A-Za-z0-9_-]{20,}$/);

    const persisted = await testDb.project.findUnique({
      where: { id: project.id },
    });
    expect(persisted?.slug).toBe(project.slug);
  });
});

describe("getProjectBySlug", () => {
  it("returns a project by its slug capability without an actor", async () => {
    const user = await makeUser();
    const created = await createProject(
      testDb,
      { userId: user.id },
      { title: "Findable" },
    );

    const found = await getProjectBySlug(testDb, null, { slug: created.slug });

    expect(found.id).toBe(created.id);
  });

  it("throws NotFoundError for an unknown slug", async () => {
    await expect(
      getProjectBySlug(testDb, null, { slug: "does-not-exist" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("treats a soft-deleted project as not found", async () => {
    const user = await makeUser();
    const created = await createProject(
      testDb,
      { userId: user.id },
      { title: "Doomed" },
    );
    await testDb.project.update({
      where: { id: created.id },
      data: { deletedAt: new Date() },
    });

    await expect(
      getProjectBySlug(testDb, null, { slug: created.slug }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("listProjects", () => {
  it("returns only the actor's own non-deleted projects", async () => {
    const owner = await makeUser("Owner");
    const other = await makeUser("Other");
    await createProject(testDb, { userId: owner.id }, { title: "A" });
    await createProject(testDb, { userId: owner.id }, { title: "B" });
    await createProject(testDb, { userId: other.id }, { title: "C" });

    const projects = await listProjects(testDb, { userId: owner.id });

    expect(projects).toHaveLength(2);
    expect(projects.map((p) => p.title).sort()).toEqual(["A", "B"]);
  });
});

describe("access: owner-only mutation", () => {
  it("rejects a non-owner write and allows the owner", async () => {
    const owner = await makeUser();
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Guarded" },
    );

    expect(() => assertCanWrite({ userId: "intruder" }, project)).toThrow(
      ForbiddenError,
    );
    expect(() => assertCanWrite({ userId: owner.id }, project)).not.toThrow();
  });
});
