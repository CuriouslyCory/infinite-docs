import { beforeEach, describe, expect, it } from "vitest";

import { assertCanWrite } from "../access";
import { type Actor } from "../actor";
import { ForbiddenError, NotFoundError } from "../errors";
import {
  createProject,
  deleteProject,
  getProjectAccess,
  getProjectBySlug,
  listProjects,
  listReferenceableProjects,
  setGuestAccess,
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

describe("listReferenceableProjects (#119, widened #120)", () => {
  it("returns owned + member(≥view) projects, excluding non-member and the current", async () => {
    const actorUser = await makeUser("Actor");
    const other = await makeUser("Other");
    const actor: Actor = { userId: actorUser.id, via: "session" };

    const owned = await createProject(testDb, actor, { title: "Owned" });
    const host = await createProject(testDb, actor, { title: "Host" });
    // A foreign project the actor is a VIEWER member of → offered (≥ view).
    const shared = await createProject(
      testDb,
      { userId: other.id },
      { title: "Shared" },
    );
    await testDb.project.update({
      where: { id: shared.id },
      data: { guestAccess: "NONE" },
    });
    await testDb.projectMembership.create({
      data: { projectId: shared.id, userId: actorUser.id, role: "VIEWER" },
    });
    // A foreign project the actor has NO membership on → excluded.
    await createProject(testDb, { userId: other.id }, { title: "Stranger" });

    const result = await listReferenceableProjects(testDb, actor, {
      excludeProjectId: host.id,
    });

    const titles = result.map((p) => p.title).sort();
    expect(titles).toEqual(["Owned", "Shared"]);
    // The excluded current project is absent; the non-member project never appears.
    expect(result.map((p) => p.id)).not.toContain(host.id);
    expect(titles).not.toContain("Stranger");
    // Narrow shape: { id, title, slug } only.
    const sample = result.find((p) => p.id === owned.id);
    expect(Object.keys(sample ?? {}).sort()).toEqual(["id", "slug", "title"]);
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

describe("setGuestAccess — ADMIN+ id-keyed write (#105, ADR-0040)", () => {
  it("the owner sets NONE, persisting it so an anonymous read 404s", async () => {
    const owner = await makeUser();
    const actor: Actor = { userId: owner.id, via: "session" };
    const project = await createProject(testDb, actor, { title: "Sharable" });

    const result = await setGuestAccess(testDb, actor, {
      projectId: project.id,
      level: "NONE",
    });
    expect(result.guestAccess).toBe("NONE");

    const persisted = await testDb.project.findUnique({
      where: { id: project.id },
    });
    expect(persisted?.guestAccess).toBe("NONE");

    // End-to-end enforcement wiring: a NONE project is not-found for anon.
    await expect(
      getProjectBySlug(testDb, null, { slug: project.slug }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an ADMIN member may set the level", async () => {
    const owner = await makeUser("Owner");
    const admin = await makeUser("Admin");
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Shared" },
    );
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: admin.id, role: "ADMIN" },
    });

    const result = await setGuestAccess(
      testDb,
      { userId: admin.id },
      { projectId: project.id, level: "NONE" },
    );
    expect(result.guestAccess).toBe("NONE");

    const persisted = await testDb.project.findUnique({
      where: { id: project.id },
    });
    expect(persisted?.guestAccess).toBe("NONE");
  });

  it("rejects an EDITOR member with ForbiddenError and leaves the level unchanged", async () => {
    const owner = await makeUser("Owner");
    const editor = await makeUser("Editor");
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Shared" },
    );
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: editor.id, role: "EDITOR" },
    });

    await expect(
      setGuestAccess(
        testDb,
        { userId: editor.id },
        { projectId: project.id, level: "NONE" },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const persisted = await testDb.project.findUnique({
      where: { id: project.id },
    });
    expect(persisted?.guestAccess).toBe("VIEW");
  });

  it("rejects a VIEWER member with ForbiddenError", async () => {
    const owner = await makeUser("Owner");
    const viewer = await makeUser("Viewer");
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Shared" },
    );
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: viewer.id, role: "VIEWER" },
    });

    await expect(
      setGuestAccess(
        testDb,
        { userId: viewer.id },
        { projectId: project.id, level: "NONE" },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects a logged-in non-member of a default (VIEW) project with ForbiddenError (id-keyed seam)", async () => {
    const owner = await makeUser("Owner");
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Public" },
    );

    await expect(
      setGuestAccess(
        testDb,
        { userId: "stranger" },
        { projectId: project.id, level: "NONE" },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const persisted = await testDb.project.findUnique({
      where: { id: project.id },
    });
    expect(persisted?.guestAccess).toBe("VIEW");
  });

  it("throws NotFoundError for an unknown projectId", async () => {
    const user = await makeUser();
    await expect(
      setGuestAccess(
        testDb,
        { userId: user.id },
        { projectId: "does-not-exist", level: "NONE" },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError when the project is already soft-deleted", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const project = await createProject(testDb, actor, { title: "Doomed" });
    await testDb.project.update({
      where: { id: project.id },
      data: { deletedAt: new Date() },
    });

    await expect(
      setGuestAccess(testDb, actor, { projectId: project.id, level: "NONE" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("getProjectAccess — ADMIN+ read with non-disclosure ladder (#105, ADR-0040)", () => {
  it("returns the level to the owner (default VIEW)", async () => {
    const owner = await makeUser();
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Mine" },
    );

    const access = await getProjectAccess(
      testDb,
      { userId: owner.id },
      { slug: project.slug },
    );
    expect(access.guestAccess).toBe("VIEW");
  });

  it("returns the level to an ADMIN member", async () => {
    const owner = await makeUser("Owner");
    const admin = await makeUser("Admin");
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Shared" },
    );
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: admin.id, role: "ADMIN" },
    });

    const access = await getProjectAccess(
      testDb,
      { userId: admin.id },
      { slug: project.slug },
    );
    expect(access.guestAccess).toBe("VIEW");
  });

  it("rejects an EDITOR member (reader below admin) with ForbiddenError", async () => {
    const owner = await makeUser("Owner");
    const editor = await makeUser("Editor");
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Shared" },
    );
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: editor.id, role: "EDITOR" },
    });

    await expect(
      getProjectAccess(testDb, { userId: editor.id }, { slug: project.slug }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects an anonymous guest-VIEW reader with ForbiddenError (existence already proven)", async () => {
    const owner = await makeUser();
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Public" },
    );

    await expect(
      getProjectAccess(testDb, null, { slug: project.slug }),
    ).rejects.toBeInstanceOf(ForbiddenError);
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
      getProjectAccess(testDb, { userId: stranger.id }, { slug: project.slug }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError for an unknown slug", async () => {
    const user = await makeUser();
    await expect(
      getProjectAccess(testDb, { userId: user.id }, { slug: "does-not-exist" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reflects the updated level after setGuestAccess (round-trip)", async () => {
    const owner = await makeUser();
    const actor: Actor = { userId: owner.id, via: "session" };
    const project = await createProject(testDb, actor, { title: "Roundtrip" });

    await setGuestAccess(testDb, actor, {
      projectId: project.id,
      level: "NONE",
    });

    const access = await getProjectAccess(testDb, actor, {
      slug: project.slug,
    });
    expect(access.guestAccess).toBe("NONE");
  });
});

describe("getProjectAccess — grown member/invite shape (#108)", () => {
  it("returns owner (separate, not in members), members with name/email/role, and viewerUserId", async () => {
    const owner = await testDb.user.create({
      data: { name: "Owner", email: "owner@team.com" },
    });
    const editor = await testDb.user.create({
      data: { name: "Edith", email: "edith@team.com" },
    });
    const viewer = await testDb.user.create({
      data: { name: null, email: "viewer@team.com" },
    });
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Shared" },
    );
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: editor.id, role: "EDITOR" },
    });
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: viewer.id, role: "VIEWER" },
    });

    const access = await getProjectAccess(
      testDb,
      { userId: owner.id },
      { slug: project.slug },
    );

    expect(access.viewerUserId).toBe(owner.id);
    expect(access.owner).toEqual({
      userId: owner.id,
      name: "Owner",
      email: "owner@team.com",
    });
    // Owner is NOT in members (ADR-0040 — identity, never a membership row).
    expect(access.members.map((m) => m.userId)).not.toContain(owner.id);
    expect(access.members).toEqual([
      {
        userId: editor.id,
        name: "Edith",
        email: "edith@team.com",
        role: "EDITOR",
      },
      {
        userId: viewer.id,
        name: null,
        email: "viewer@team.com",
        role: "VIEWER",
      },
    ]);
  });

  it("an ADMIN member (not the owner) gets the full payload with their own viewerUserId", async () => {
    const owner = await makeUser("Owner");
    const admin = await testDb.user.create({
      data: { name: "Admin", email: "admin@team.com" },
    });
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Shared" },
    );
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: admin.id, role: "ADMIN" },
    });

    const access = await getProjectAccess(
      testDb,
      { userId: admin.id },
      { slug: project.slug },
    );

    expect(access.viewerUserId).toBe(admin.id);
    expect(access.owner.userId).toBe(owner.id);
    // The admin themselves IS a membership row (only the owner is excluded).
    expect(access.members.map((m) => m.userId)).toContain(admin.id);
  });

  it("includes expired and maxed-out invites but EXCLUDES revoked ones", async () => {
    const owner = await makeUser("Owner");
    const project = await createProject(
      testDb,
      { userId: owner.id },
      { title: "Invites" },
    );

    const active = await testDb.projectInvite.create({
      data: {
        projectId: project.id,
        role: "VIEWER",
        tokenHash: "hash-active",
        prefix: "infinv_aaa",
        keyVersion: 1,
      },
    });
    const expired = await testDb.projectInvite.create({
      data: {
        projectId: project.id,
        role: "EDITOR",
        tokenHash: "hash-expired",
        prefix: "infinv_bbb",
        keyVersion: 1,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    const maxed = await testDb.projectInvite.create({
      data: {
        projectId: project.id,
        role: "VIEWER",
        tokenHash: "hash-maxed",
        prefix: "infinv_ccc",
        keyVersion: 1,
        maxUses: 2,
        useCount: 2,
      },
    });
    const revoked = await testDb.projectInvite.create({
      data: {
        projectId: project.id,
        role: "ADMIN",
        tokenHash: "hash-revoked",
        prefix: "infinv_ddd",
        keyVersion: 1,
        revokedAt: new Date(),
      },
    });

    const access = await getProjectAccess(
      testDb,
      { userId: owner.id },
      { slug: project.slug },
    );

    const ids = access.invites.map((i) => i.id);
    expect(ids).toContain(active.id);
    expect(ids).toContain(expired.id);
    expect(ids).toContain(maxed.id);
    expect(ids).not.toContain(revoked.id);

    const maxedRow = access.invites.find((i) => i.id === maxed.id);
    expect(maxedRow).toMatchObject({
      prefix: "infinv_ccc",
      role: "VIEWER",
      maxUses: 2,
      useCount: 2,
    });
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
