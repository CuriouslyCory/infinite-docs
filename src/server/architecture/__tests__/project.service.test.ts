import { beforeEach, describe, expect, it } from "vitest";

import { assertCanWrite } from "../access";
import { type Actor } from "../actor";
import { ForbiddenError, NotFoundError } from "../errors";
import {
  createProject,
  deleteProject,
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

describe("deleteProject", () => {
  it("soft-deletes the actor's project so it reads as not found", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const project = await createProject(testDb, actor, { title: "Doomed" });

    const result = await deleteProject(testDb, actor, { slug: project.slug });
    expect(result.id).toBe(project.id);

    const persisted = await testDb.project.findUnique({
      where: { id: project.id },
    });
    expect(persisted?.deletedAt).toBeInstanceOf(Date);

    await expect(
      getProjectBySlug(testDb, null, { slug: project.slug }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a non-owner and leaves the project intact", async () => {
    const owner = await makeUser("Owner");
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Guarded" },
    );

    await expect(
      deleteProject(testDb, { userId: "intruder" }, { slug: project.slug }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const persisted = await testDb.project.findUnique({
      where: { id: project.id },
    });
    expect(persisted?.deletedAt).toBeNull();
  });

  it("throws NotFoundError for an unknown slug", async () => {
    const user = await makeUser();
    await expect(
      deleteProject(testDb, { userId: user.id }, { slug: "does-not-exist" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError when the project is already deleted", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const project = await createProject(testDb, actor, { title: "Doomed" });
    await deleteProject(testDb, actor, { slug: project.slug });

    await expect(
      deleteProject(testDb, actor, { slug: project.slug }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("leaves child rows intact — a lone soft-delete, no cascade", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const project = await createProject(testDb, actor, {
      title: "Has Children",
    });
    const source = await testDb.node.create({
      data: { projectId: project.id, title: "A" },
    });
    const target = await testDb.node.create({
      data: { projectId: project.id, title: "B" },
    });
    const edge = await testDb.edge.create({
      data: { projectId: project.id, sourceId: source.id, targetId: target.id },
    });

    await deleteProject(testDb, actor, { slug: project.slug });

    const [persistedSource, persistedTarget, persistedEdge] = await Promise.all(
      [
        testDb.node.findUnique({ where: { id: source.id } }),
        testDb.node.findUnique({ where: { id: target.id } }),
        testDb.edge.findUnique({ where: { id: edge.id } }),
      ],
    );
    expect(persistedSource?.deletedAt).toBeNull();
    expect(persistedTarget?.deletedAt).toBeNull();
    expect(persistedEdge?.deletedAt).toBeNull();
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

describe("getProjectBySlug — viewerCapability + guest access (ADR-0040)", () => {
  it("reports the owner's capability as `owner`", async () => {
    const owner = await makeUser();
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Mine" },
    );

    const found = await getProjectBySlug(
      testDb,
      { userId: owner.id },
      { slug: project.slug },
    );
    expect(found.viewerCapability).toBe("owner");
  });

  it("reports an anonymous viewer's capability as `view` at the default guestAccess VIEW", async () => {
    const owner = await makeUser();
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Public" },
    );

    const found = await getProjectBySlug(testDb, null, { slug: project.slug });
    expect(found.viewerCapability).toBe("view");
  });

  it("reports a member's capability from their role", async () => {
    const owner = await makeUser("Owner");
    const member = await makeUser("Member");
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Shared" },
    );
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: member.id, role: "EDITOR" },
    });

    const found = await getProjectBySlug(
      testDb,
      { userId: member.id },
      { slug: project.slug },
    );
    expect(found.viewerCapability).toBe("edit");
  });

  it("throws NotFoundError (not Forbidden) for an anonymous viewer at guestAccess NONE", async () => {
    const owner = await makeUser();
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Locked" },
    );
    await testDb.project.update({
      where: { id: project.id },
      data: { guestAccess: "NONE" },
    });

    await expect(
      getProjectBySlug(testDb, null, { slug: project.slug }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError (not Forbidden) for a logged-in non-member at guestAccess NONE", async () => {
    const owner = await makeUser("Owner");
    const stranger = await makeUser("Stranger");
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Locked" },
    );
    await testDb.project.update({
      where: { id: project.id },
      data: { guestAccess: "NONE" },
    });

    await expect(
      getProjectBySlug(testDb, { userId: stranger.id }, { slug: project.slug }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("still resolves for the owner and a member when guestAccess is NONE", async () => {
    const owner = await makeUser("Owner");
    const member = await makeUser("Member");
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Members only" },
    );
    await testDb.project.update({
      where: { id: project.id },
      data: { guestAccess: "NONE" },
    });
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: member.id, role: "VIEWER" },
    });

    const asOwner = await getProjectBySlug(
      testDb,
      { userId: owner.id },
      { slug: project.slug },
    );
    expect(asOwner.viewerCapability).toBe("owner");

    const asMember = await getProjectBySlug(
      testDb,
      { userId: member.id },
      { slug: project.slug },
    );
    expect(asMember.viewerCapability).toBe("view");
  });
});

describe("deleteProject — owner-only, ADMIN cannot delete (ADR-0040)", () => {
  it("rejects a non-owner ADMIN member with ForbiddenError and leaves the project intact", async () => {
    const owner = await makeUser("Owner");
    const admin = await makeUser("Admin");
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Guarded" },
    );
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: admin.id, role: "ADMIN" },
    });

    await expect(
      deleteProject(testDb, { userId: admin.id }, { slug: project.slug }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const persisted = await testDb.project.findUnique({
      where: { id: project.id },
    });
    expect(persisted?.deletedAt).toBeNull();
  });
});

describe("deleteProject — non-disclosure on slug-keyed write (ADR-0040)", () => {
  it("throws NotFoundError (not Forbidden) for a logged-in non-member of a guestAccess=NONE project", async () => {
    const owner = await makeUser("Owner");
    const stranger = await makeUser("Stranger");
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Locked" },
    );
    await testDb.project.update({
      where: { id: project.id },
      data: { guestAccess: "NONE" },
    });

    await expect(
      deleteProject(testDb, { userId: stranger.id }, { slug: project.slug }),
    ).rejects.toBeInstanceOf(NotFoundError);

    const persisted = await testDb.project.findUnique({
      where: { id: project.id },
    });
    expect(persisted?.deletedAt).toBeNull();
  });

  it("throws ForbiddenError (existence already proven) for a guest-VIEW reader who is not the owner", async () => {
    const owner = await makeUser("Owner");
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Public but undeletable" },
    );

    // Default guestAccess is VIEW, so a non-member stranger CAN read this
    // project — they have proven it exists and a write-deny discloses nothing.
    await expect(
      deleteProject(testDb, { userId: "stranger" }, { slug: project.slug }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const persisted = await testDb.project.findUnique({
      where: { id: project.id },
    });
    expect(persisted?.deletedAt).toBeNull();
  });
});
