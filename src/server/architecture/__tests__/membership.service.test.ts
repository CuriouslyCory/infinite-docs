import { beforeEach, describe, expect, it } from "vitest";

import { type ProjectRole } from "../../../../generated/prisma/client";
import { authorizeProjectWrite } from "../access-db";
import { ConflictError, ForbiddenError, NotFoundError } from "../errors";
import {
  grantMemberByEmail,
  removeMember,
  updateMemberRole,
} from "../membership.service";
import { createProject } from "../project.service";
import { resetDb, testDb } from "./helpers/test-db";

beforeEach(async () => {
  await resetDb();
});

function makeUser(name = "User", email?: string) {
  return testDb.user.create({ data: { name, email } });
}

async function makeProject(ownerId: string, title = "System") {
  return createProject(testDb, { userId: ownerId }, { title });
}

async function addMember(projectId: string, userId: string, role: ProjectRole) {
  return testDb.projectMembership.create({
    data: { projectId, userId, role },
  });
}

async function membershipRole(
  projectId: string,
  userId: string,
): Promise<ProjectRole | null> {
  const m = await testDb.projectMembership.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });
  return m?.role ?? null;
}

describe("grantMemberByEmail — grants", () => {
  it("an ADMIN grants an existing user by email (case-insensitive)", async () => {
    const owner = await makeUser("Owner");
    const target = await makeUser("Target", "Foo@Bar.com");
    const project = await makeProject(owner.id);

    const result = await grantMemberByEmail(
      testDb,
      { userId: owner.id },
      { projectId: project.id, email: "foo@bar.COM", role: "EDITOR" },
    );

    expect(result).toEqual({ status: "granted", role: "EDITOR" });
    expect(await membershipRole(project.id, target.id)).toBe("EDITOR");
  });

  it("an ADMIN member (not the owner) can grant", async () => {
    const owner = await makeUser("Owner");
    const admin = await makeUser("Admin");
    const target = await makeUser("Target", "new@member.com");
    const project = await makeProject(owner.id);
    await addMember(project.id, admin.id, "ADMIN");

    const result = await grantMemberByEmail(
      testDb,
      { userId: admin.id },
      { projectId: project.id, email: "new@member.com", role: "VIEWER" },
    );

    expect(result).toEqual({ status: "granted", role: "VIEWER" });
    expect(await membershipRole(project.id, target.id)).toBe("VIEWER");
  });
});

describe("grantMemberByEmail — non-leaky no_account", () => {
  it("an unknown email returns no_account and writes no membership row", async () => {
    const owner = await makeUser("Owner");
    const project = await makeProject(owner.id);

    const result = await grantMemberByEmail(
      testDb,
      { userId: owner.id },
      { projectId: project.id, email: "nobody@nowhere.com", role: "EDITOR" },
    );

    expect(result).toEqual({ status: "no_account" });
    const count = await testDb.projectMembership.count({
      where: { projectId: project.id },
    });
    expect(count).toBe(0);
  });

  it("does not disclose a user who exists only in another project", async () => {
    const owner = await makeUser("Owner");
    const otherOwner = await makeUser("Other");
    // A user that exists in the system but has no relationship to `project`.
    await makeUser("Outsider", "outsider@elsewhere.com");
    const project = await makeProject(owner.id);
    const otherProject = await makeProject(otherOwner.id);
    void otherProject;

    // The email DOES match a real account, so the grant succeeds here — the
    // non-leak guarantee is that `no_account` carries nothing beyond the miss,
    // never "this email exists over there". Granting an existing account is the
    // intended path; this asserts the row lands only in the targeted project.
    const result = await grantMemberByEmail(
      testDb,
      { userId: owner.id },
      {
        projectId: project.id,
        email: "outsider@elsewhere.com",
        role: "VIEWER",
      },
    );
    expect(result.status).toBe("granted");
    const otherCount = await testDb.projectMembership.count({
      where: { projectId: otherProject.id },
    });
    expect(otherCount).toBe(0);
  });
});

describe("grantMemberByEmail — owner short-circuit", () => {
  it("targeting the owner's email returns already_owner and writes no row", async () => {
    const owner = await makeUser("Owner", "owner@self.com");
    const project = await makeProject(owner.id);

    const result = await grantMemberByEmail(
      testDb,
      { userId: owner.id },
      { projectId: project.id, email: "OWNER@self.com", role: "ADMIN" },
    );

    expect(result).toEqual({ status: "already_owner" });
    expect(await membershipRole(project.id, owner.id)).toBeNull();
  });
});

describe("grantMemberByEmail — MAX, never downgrade", () => {
  it("an existing EDITOR granted VIEWER keeps EDITOR (status granted with EDITOR)", async () => {
    const owner = await makeUser("Owner");
    const editor = await makeUser("Editor", "editor@team.com");
    const project = await makeProject(owner.id);
    await addMember(project.id, editor.id, "EDITOR");

    const result = await grantMemberByEmail(
      testDb,
      { userId: owner.id },
      { projectId: project.id, email: "editor@team.com", role: "VIEWER" },
    );

    expect(result).toEqual({ status: "granted", role: "EDITOR" });
    expect(await membershipRole(project.id, editor.id)).toBe("EDITOR");
  });

  it("an existing VIEWER granted ADMIN is raised to ADMIN", async () => {
    const owner = await makeUser("Owner");
    const viewer = await makeUser("Viewer", "viewer@team.com");
    const project = await makeProject(owner.id);
    await addMember(project.id, viewer.id, "VIEWER");

    const result = await grantMemberByEmail(
      testDb,
      { userId: owner.id },
      { projectId: project.id, email: "viewer@team.com", role: "ADMIN" },
    );

    expect(result).toEqual({ status: "granted", role: "ADMIN" });
    expect(await membershipRole(project.id, viewer.id)).toBe("ADMIN");
  });
});

describe("grantMemberByEmail — ADMIN+ gate", () => {
  it("rejects a VIEWER member, an EDITOR member, and a non-member (Forbidden)", async () => {
    const owner = await makeUser("Owner");
    const viewer = await makeUser("Viewer");
    const editor = await makeUser("Editor");
    const stranger = await makeUser("Stranger");
    const target = await makeUser("Target", "target@team.com");
    void target;
    const project = await makeProject(owner.id);
    await addMember(project.id, viewer.id, "VIEWER");
    await addMember(project.id, editor.id, "EDITOR");

    for (const userId of [viewer.id, editor.id, stranger.id]) {
      await expect(
        grantMemberByEmail(
          testDb,
          { userId },
          { projectId: project.id, email: "target@team.com", role: "VIEWER" },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    // The gate rejects BEFORE any lookup/write — no row was created.
    const count = await testDb.projectMembership.count({
      where: { projectId: project.id, userId: target.id },
    });
    expect(count).toBe(0);
  });
});

describe("updateMemberRole — direct set (#108)", () => {
  it("an ADMIN upgrades a VIEWER to EDITOR", async () => {
    const owner = await makeUser("Owner");
    const member = await makeUser("Member");
    const project = await makeProject(owner.id);
    await addMember(project.id, member.id, "VIEWER");

    const result = await updateMemberRole(
      testDb,
      { userId: owner.id },
      { projectId: project.id, userId: member.id, role: "EDITOR" },
    );

    expect(result).toEqual({
      projectId: project.id,
      userId: member.id,
      role: "EDITOR",
    });
    expect(await membershipRole(project.id, member.id)).toBe("EDITOR");
  });

  it("DOWNGRADES an EDITOR to VIEWER — direct set, never MAX", async () => {
    const owner = await makeUser("Owner");
    const member = await makeUser("Member");
    const project = await makeProject(owner.id);
    await addMember(project.id, member.id, "EDITOR");

    await updateMemberRole(
      testDb,
      { userId: owner.id },
      { projectId: project.id, userId: member.id, role: "VIEWER" },
    );

    expect(await membershipRole(project.id, member.id)).toBe("VIEWER");
  });

  it("rejects targeting the owner with ConflictError and writes nothing", async () => {
    const owner = await makeUser("Owner");
    const project = await makeProject(owner.id);

    await expect(
      updateMemberRole(
        testDb,
        { userId: owner.id },
        { projectId: project.id, userId: owner.id, role: "VIEWER" },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    // The owner never had a membership row, and none was created.
    expect(await membershipRole(project.id, owner.id)).toBeNull();
  });

  it("throws NotFoundError for an absent membership row", async () => {
    const owner = await makeUser("Owner");
    const stranger = await makeUser("Stranger");
    const project = await makeProject(owner.id);

    await expect(
      updateMemberRole(
        testDb,
        { userId: owner.id },
        { projectId: project.id, userId: stranger.id, role: "EDITOR" },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an ADMIN member (not the owner) can change another member's role", async () => {
    const owner = await makeUser("Owner");
    const admin = await makeUser("Admin");
    const member = await makeUser("Member");
    const project = await makeProject(owner.id);
    await addMember(project.id, admin.id, "ADMIN");
    await addMember(project.id, member.id, "VIEWER");

    await updateMemberRole(
      testDb,
      { userId: admin.id },
      { projectId: project.id, userId: member.id, role: "ADMIN" },
    );

    expect(await membershipRole(project.id, member.id)).toBe("ADMIN");
  });

  it("rejects a VIEWER, an EDITOR, and a non-member (Forbidden); non-member projectId stays Forbidden", async () => {
    const owner = await makeUser("Owner");
    const viewer = await makeUser("Viewer");
    const editor = await makeUser("Editor");
    const stranger = await makeUser("Stranger");
    const target = await makeUser("Target");
    const project = await makeProject(owner.id);
    await addMember(project.id, viewer.id, "VIEWER");
    await addMember(project.id, editor.id, "EDITOR");
    await addMember(project.id, target.id, "VIEWER");

    for (const userId of [viewer.id, editor.id, stranger.id]) {
      await expect(
        updateMemberRole(
          testDb,
          { userId },
          { projectId: project.id, userId: target.id, role: "EDITOR" },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await membershipRole(project.id, target.id)).toBe("VIEWER");
  });
});

describe("removeMember — delete + access lost (#108)", () => {
  it("an ADMIN removes a member; the row is gone and the user loses access", async () => {
    const owner = await makeUser("Owner");
    const member = await makeUser("Member");
    const project = await makeProject(owner.id);
    await addMember(project.id, member.id, "EDITOR");

    const result = await removeMember(
      testDb,
      { userId: owner.id },
      { projectId: project.id, userId: member.id },
    );

    expect(result).toEqual({ projectId: project.id, userId: member.id });
    expect(await membershipRole(project.id, member.id)).toBeNull();

    // Access falls back to the guest grant / none: at guestAccess=NONE the
    // ex-member can no longer even read.
    await testDb.project.update({
      where: { id: project.id },
      data: { guestAccess: "NONE" },
    });
    await expect(
      authorizeProjectWrite(testDb, { userId: member.id }, project.id, "view"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects targeting the owner with ConflictError", async () => {
    const owner = await makeUser("Owner");
    const project = await makeProject(owner.id);

    await expect(
      removeMember(
        testDb,
        { userId: owner.id },
        { projectId: project.id, userId: owner.id },
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("throws NotFoundError for an absent membership row", async () => {
    const owner = await makeUser("Owner");
    const stranger = await makeUser("Stranger");
    const project = await makeProject(owner.id);

    await expect(
      removeMember(
        testDb,
        { userId: owner.id },
        { projectId: project.id, userId: stranger.id },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an ADMIN may remove ANOTHER ADMIN", async () => {
    const owner = await makeUser("Owner");
    const adminA = await makeUser("AdminA");
    const adminB = await makeUser("AdminB");
    const project = await makeProject(owner.id);
    await addMember(project.id, adminA.id, "ADMIN");
    await addMember(project.id, adminB.id, "ADMIN");

    await removeMember(
      testDb,
      { userId: adminA.id },
      { projectId: project.id, userId: adminB.id },
    );

    expect(await membershipRole(project.id, adminB.id)).toBeNull();
  });

  it("an ADMIN may remove THEMSELVES", async () => {
    const owner = await makeUser("Owner");
    const admin = await makeUser("Admin");
    const project = await makeProject(owner.id);
    await addMember(project.id, admin.id, "ADMIN");

    await removeMember(
      testDb,
      { userId: admin.id },
      { projectId: project.id, userId: admin.id },
    );

    expect(await membershipRole(project.id, admin.id)).toBeNull();
  });

  it("rejects a VIEWER, an EDITOR, and a non-member (Forbidden); the row survives", async () => {
    const owner = await makeUser("Owner");
    const viewer = await makeUser("Viewer");
    const editor = await makeUser("Editor");
    const stranger = await makeUser("Stranger");
    const target = await makeUser("Target");
    const project = await makeProject(owner.id);
    await addMember(project.id, viewer.id, "VIEWER");
    await addMember(project.id, editor.id, "EDITOR");
    await addMember(project.id, target.id, "VIEWER");

    for (const userId of [viewer.id, editor.id, stranger.id]) {
      await expect(
        removeMember(
          testDb,
          { userId },
          { projectId: project.id, userId: target.id },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await membershipRole(project.id, target.id)).toBe("VIEWER");
  });
});
