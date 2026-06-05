import { beforeEach, describe, expect, it } from "vitest";

import { type ProjectRole } from "../../../../generated/prisma/client";
import { ForbiddenError, NotFoundError } from "../errors";
import { claimInvite, createInvite, revokeInvite } from "../invite.service";
import { createProject } from "../project.service";
import { hashToken } from "../token-hash";
import { resetDb, testDb } from "./helpers/test-db";

// These tests HMAC with the pepper, so `API_TOKEN_PEPPER` must be set in
// .env.test (loaded by setup-env.ts). The concurrency tests use Promise.all
// against the real test DB so the row-lock / @@unique serialization is exercised
// for real, not simulated.

beforeEach(async () => {
  await resetDb();
});

function makeUser(name = "User") {
  return testDb.user.create({ data: { name } });
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

async function useCountOf(inviteId: string): Promise<number> {
  const row = await testDb.projectInvite.findUniqueOrThrow({
    where: { id: inviteId },
    select: { useCount: true },
  });
  return row.useCount;
}

describe("createInvite", () => {
  it("mints an invite shown once, with a matching prefix and the chosen role", async () => {
    const owner = await makeUser("Owner");
    const project = await makeProject(owner.id);

    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "EDITOR", expiresInDays: 30 },
    );

    expect(minted.token).toMatch(/^infinv_[A-Za-z0-9_-]{20,}$/);
    expect(minted.token.startsWith(minted.prefix)).toBe(true);
    expect(minted.role).toBe("EDITOR");
    expect(minted.expiresAt).not.toBeNull();

    const rows = await testDb.projectInvite.findMany({
      where: { projectId: project.id },
    });
    expect(rows).toHaveLength(1);
  });

  it("stores only the keyed hash, never the raw token; persists prefix/keyVersion/role/maxUses", async () => {
    const owner = await makeUser("Owner");
    const project = await makeProject(owner.id);

    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "VIEWER", maxUses: 5 },
    );

    const row = await testDb.projectInvite.findUniqueOrThrow({
      where: { tokenHash: hashToken(minted.token) },
    });
    expect(JSON.stringify(row)).not.toContain(minted.token);
    expect(row.tokenHash).toBe(hashToken(minted.token));
    expect(row.prefix).toBe(minted.prefix);
    expect(row.keyVersion).toBe(1);
    expect(row.role).toBe("VIEWER");
    expect(row.maxUses).toBe(5);
    expect(row.useCount).toBe(0);
  });

  it("supports a non-expiring, unlimited-use invite", async () => {
    const owner = await makeUser("Owner");
    const project = await makeProject(owner.id);

    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "VIEWER", expiresInDays: null },
    );
    expect(minted.expiresAt).toBeNull();

    const row = await testDb.projectInvite.findUniqueOrThrow({
      where: { tokenHash: hashToken(minted.token) },
    });
    expect(row.maxUses).toBeNull();
  });

  it("allows an ADMIN member to create", async () => {
    const owner = await makeUser("Owner");
    const admin = await makeUser("Admin");
    const project = await makeProject(owner.id);
    await addMember(project.id, admin.id, "ADMIN");

    const minted = await createInvite(
      testDb,
      { userId: admin.id },
      { projectId: project.id, role: "VIEWER" },
    );
    expect(minted.token).toMatch(/^infinv_/);
  });

  it("rejects a VIEWER member, an EDITOR member, and a non-member (Forbidden)", async () => {
    const owner = await makeUser("Owner");
    const viewer = await makeUser("Viewer");
    const editor = await makeUser("Editor");
    const stranger = await makeUser("Stranger");
    const project = await makeProject(owner.id);
    await addMember(project.id, viewer.id, "VIEWER");
    await addMember(project.id, editor.id, "EDITOR");

    for (const userId of [viewer.id, editor.id, stranger.id]) {
      await expect(
        createInvite(
          testDb,
          { userId },
          { projectId: project.id, role: "VIEWER" },
        ),
      ).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe("claimInvite — grants", () => {
  it("an EDITOR invite makes a non-member an EDITOR", async () => {
    const owner = await makeUser("Owner");
    const claimer = await makeUser("Claimer");
    const project = await makeProject(owner.id);
    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "EDITOR" },
    );

    const { slug } = await claimInvite(
      testDb,
      { userId: claimer.id },
      { token: minted.token },
    );

    expect(slug).toBe(project.slug);
    expect(await membershipRole(project.id, claimer.id)).toBe("EDITOR");
  });

  it("a VIEWER invite makes a non-member a VIEWER", async () => {
    const owner = await makeUser("Owner");
    const claimer = await makeUser("Claimer");
    const project = await makeProject(owner.id);
    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "VIEWER" },
    );

    await claimInvite(testDb, { userId: claimer.id }, { token: minted.token });
    expect(await membershipRole(project.id, claimer.id)).toBe("VIEWER");
  });
});

describe("claimInvite — idempotency, MAX, owner, equal-or-higher", () => {
  it("re-claim by the same user consumes exactly one use and leaves one row", async () => {
    const owner = await makeUser("Owner");
    const claimer = await makeUser("Claimer");
    const project = await makeProject(owner.id);
    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "EDITOR" },
    );
    const invite = await testDb.projectInvite.findUniqueOrThrow({
      where: { tokenHash: hashToken(minted.token) },
    });

    await claimInvite(testDb, { userId: claimer.id }, { token: minted.token });
    await claimInvite(testDb, { userId: claimer.id }, { token: minted.token });

    expect(await useCountOf(invite.id)).toBe(1);
    const rows = await testDb.projectMembership.findMany({
      where: { projectId: project.id, userId: claimer.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("EDITOR");
  });

  it("MAX rule: an existing EDITOR claiming a VIEWER invite keeps EDITOR and consumes no use", async () => {
    const owner = await makeUser("Owner");
    const editor = await makeUser("Editor");
    const project = await makeProject(owner.id);
    await addMember(project.id, editor.id, "EDITOR");
    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "VIEWER" },
    );
    const invite = await testDb.projectInvite.findUniqueOrThrow({
      where: { tokenHash: hashToken(minted.token) },
    });

    await claimInvite(testDb, { userId: editor.id }, { token: minted.token });

    expect(await membershipRole(project.id, editor.id)).toBe("EDITOR");
    expect(await useCountOf(invite.id)).toBe(0);
  });

  it("an existing VIEWER claiming an ADMIN invite is raised to ADMIN and consumes one use", async () => {
    const owner = await makeUser("Owner");
    const viewer = await makeUser("Viewer");
    const project = await makeProject(owner.id);
    await addMember(project.id, viewer.id, "VIEWER");
    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "ADMIN" },
    );
    const invite = await testDb.projectInvite.findUniqueOrThrow({
      where: { tokenHash: hashToken(minted.token) },
    });

    await claimInvite(testDb, { userId: viewer.id }, { token: minted.token });

    expect(await membershipRole(project.id, viewer.id)).toBe("ADMIN");
    expect(await useCountOf(invite.id)).toBe(1);
  });

  it("owner claiming their own invite is a no-op success: no use, no membership row", async () => {
    const owner = await makeUser("Owner");
    const project = await makeProject(owner.id);
    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "ADMIN" },
    );
    const invite = await testDb.projectInvite.findUniqueOrThrow({
      where: { tokenHash: hashToken(minted.token) },
    });

    const { slug } = await claimInvite(
      testDb,
      { userId: owner.id },
      { token: minted.token },
    );

    expect(slug).toBe(project.slug);
    expect(await useCountOf(invite.id)).toBe(0);
    expect(await membershipRole(project.id, owner.id)).toBeNull();
  });

  it("an existing ADMIN claiming an EDITOR invite is a no-op: no use, no downgrade", async () => {
    const owner = await makeUser("Owner");
    const admin = await makeUser("Admin");
    const project = await makeProject(owner.id);
    await addMember(project.id, admin.id, "ADMIN");
    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "EDITOR" },
    );
    const invite = await testDb.projectInvite.findUniqueOrThrow({
      where: { tokenHash: hashToken(minted.token) },
    });

    await claimInvite(testDb, { userId: admin.id }, { token: minted.token });

    expect(await membershipRole(project.id, admin.id)).toBe("ADMIN");
    expect(await useCountOf(invite.id)).toBe(0);
  });
});

describe("claimInvite — invalid states collapse to one NotFoundError", () => {
  it("an unknown token throws NotFoundError", async () => {
    const claimer = await makeUser("Claimer");
    await expect(
      claimInvite(
        testDb,
        { userId: claimer.id },
        { token: "infinv_totally-unknown-token" },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("an expired invite throws NotFoundError and consumes nothing", async () => {
    const owner = await makeUser("Owner");
    const claimer = await makeUser("Claimer");
    const project = await makeProject(owner.id);
    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "EDITOR" },
    );
    const invite = await testDb.projectInvite.findUniqueOrThrow({
      where: { tokenHash: hashToken(minted.token) },
    });
    await testDb.projectInvite.update({
      where: { id: invite.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      claimInvite(testDb, { userId: claimer.id }, { token: minted.token }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await membershipRole(project.id, claimer.id)).toBeNull();
  });

  it("a revoked invite throws NotFoundError", async () => {
    const owner = await makeUser("Owner");
    const claimer = await makeUser("Claimer");
    const project = await makeProject(owner.id);
    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "EDITOR" },
    );
    const invite = await testDb.projectInvite.findUniqueOrThrow({
      where: { tokenHash: hashToken(minted.token) },
    });
    await testDb.projectInvite.update({
      where: { id: invite.id },
      data: { revokedAt: new Date() },
    });

    await expect(
      claimInvite(testDb, { userId: claimer.id }, { token: minted.token }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("a maxed-out invite throws NotFoundError", async () => {
    const owner = await makeUser("Owner");
    const first = await makeUser("First");
    const second = await makeUser("Second");
    const project = await makeProject(owner.id);
    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "VIEWER", maxUses: 1 },
    );

    await claimInvite(testDb, { userId: first.id }, { token: minted.token });

    await expect(
      claimInvite(testDb, { userId: second.id }, { token: minted.token }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(await membershipRole(project.id, second.id)).toBeNull();
  });

  it("an invite for a soft-deleted project throws NotFoundError", async () => {
    const owner = await makeUser("Owner");
    const claimer = await makeUser("Claimer");
    const project = await makeProject(owner.id);
    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "EDITOR" },
    );
    await testDb.project.update({
      where: { id: project.id },
      data: { deletedAt: new Date() },
    });

    await expect(
      claimInvite(testDb, { userId: claimer.id }, { token: minted.token }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("claimInvite — revoke does not strip prior membership", () => {
  it("a member who already claimed keeps their role after the invite is revoked", async () => {
    const owner = await makeUser("Owner");
    const claimer = await makeUser("Claimer");
    const project = await makeProject(owner.id);
    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "EDITOR" },
    );
    const invite = await testDb.projectInvite.findUniqueOrThrow({
      where: { tokenHash: hashToken(minted.token) },
    });

    await claimInvite(testDb, { userId: claimer.id }, { token: minted.token });
    await testDb.projectInvite.update({
      where: { id: invite.id },
      data: { revokedAt: new Date() },
    });

    expect(await membershipRole(project.id, claimer.id)).toBe("EDITOR");
  });
});

describe("claimInvite — concurrency", () => {
  it("N=10 different users vs maxUses=3 grants exactly 3 (useCount=3, 7 NotFound)", async () => {
    const owner = await makeUser("Owner");
    const project = await makeProject(owner.id);
    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "EDITOR", maxUses: 3 },
    );
    const invite = await testDb.projectInvite.findUniqueOrThrow({
      where: { tokenHash: hashToken(minted.token) },
    });

    const users = await Promise.all(
      Array.from({ length: 10 }, (_, i) => makeUser(`Claimer${i}`)),
    );

    const results = await Promise.allSettled(
      users.map((u) =>
        claimInvite(testDb, { userId: u.id }, { token: minted.token }),
      ),
    );

    const granted = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof NotFoundError,
    ).length;

    expect(granted).toBe(3);
    expect(rejected).toBe(7);
    expect(await useCountOf(invite.id)).toBe(3);
    const memberships = await testDb.projectMembership.count({
      where: { projectId: project.id },
    });
    expect(memberships).toBe(3);
  });

  it("the same new user firing 2 concurrent claims consumes exactly one use and writes one row", async () => {
    const owner = await makeUser("Owner");
    const claimer = await makeUser("Claimer");
    const project = await makeProject(owner.id);
    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "EDITOR", maxUses: 5 },
    );
    const invite = await testDb.projectInvite.findUniqueOrThrow({
      where: { tokenHash: hashToken(minted.token) },
    });

    const results = await Promise.allSettled([
      claimInvite(testDb, { userId: claimer.id }, { token: minted.token }),
      claimInvite(testDb, { userId: claimer.id }, { token: minted.token }),
    ]);

    // Both claims should succeed (a same-user re-claim is a no-op success, never
    // a failure), but only ONE use is consumed and exactly ONE row exists.
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    expect(fulfilled).toBe(2);

    expect(await useCountOf(invite.id)).toBe(1);
    const rows = await testDb.projectMembership.findMany({
      where: { projectId: project.id, userId: claimer.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe("EDITOR");
  });
});

describe("revokeInvite — admin-gated, non-disclosing, idempotent (#108)", () => {
  async function mintInvite(ownerId: string, projectId: string) {
    const minted = await createInvite(
      testDb,
      { userId: ownerId },
      { projectId, role: "EDITOR" },
    );
    return testDb.projectInvite.findUniqueOrThrow({
      where: { tokenHash: hashToken(minted.token) },
    });
  }

  it("an ADMIN (owner) sets revokedAt and blocks a future claim", async () => {
    const owner = await makeUser("Owner");
    const claimer = await makeUser("Claimer");
    const project = await makeProject(owner.id);
    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "EDITOR" },
    );
    const invite = await testDb.projectInvite.findUniqueOrThrow({
      where: { tokenHash: hashToken(minted.token) },
    });

    const result = await revokeInvite(
      testDb,
      { userId: owner.id },
      { inviteId: invite.id },
    );

    expect(result).toEqual({ id: invite.id });
    const row = await testDb.projectInvite.findUniqueOrThrow({
      where: { id: invite.id },
      select: { revokedAt: true },
    });
    expect(row.revokedAt).not.toBeNull();

    // A future claim of the now-revoked token is blocked.
    await expect(
      claimInvite(testDb, { userId: claimer.id }, { token: minted.token }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("revoking KEEPS a membership already granted via the link", async () => {
    const owner = await makeUser("Owner");
    const claimer = await makeUser("Claimer");
    const project = await makeProject(owner.id);
    const minted = await createInvite(
      testDb,
      { userId: owner.id },
      { projectId: project.id, role: "EDITOR" },
    );
    const invite = await testDb.projectInvite.findUniqueOrThrow({
      where: { tokenHash: hashToken(minted.token) },
    });

    await claimInvite(testDb, { userId: claimer.id }, { token: minted.token });
    await revokeInvite(testDb, { userId: owner.id }, { inviteId: invite.id });

    expect(await membershipRole(project.id, claimer.id)).toBe("EDITOR");
  });

  it("is idempotent — a second revoke succeeds with revokedAt unchanged", async () => {
    const owner = await makeUser("Owner");
    const project = await makeProject(owner.id);
    const invite = await mintInvite(owner.id, project.id);

    await revokeInvite(testDb, { userId: owner.id }, { inviteId: invite.id });
    const first = await testDb.projectInvite.findUniqueOrThrow({
      where: { id: invite.id },
      select: { revokedAt: true },
    });

    const result = await revokeInvite(
      testDb,
      { userId: owner.id },
      { inviteId: invite.id },
    );
    expect(result).toEqual({ id: invite.id });

    const second = await testDb.projectInvite.findUniqueOrThrow({
      where: { id: invite.id },
      select: { revokedAt: true },
    });
    expect(second.revokedAt?.getTime()).toBe(first.revokedAt?.getTime());
  });

  it("an ADMIN member (not the owner) can revoke", async () => {
    const owner = await makeUser("Owner");
    const admin = await makeUser("Admin");
    const project = await makeProject(owner.id);
    await addMember(project.id, admin.id, "ADMIN");
    const invite = await mintInvite(owner.id, project.id);

    await revokeInvite(testDb, { userId: admin.id }, { inviteId: invite.id });

    const row = await testDb.projectInvite.findUniqueOrThrow({
      where: { id: invite.id },
      select: { revokedAt: true },
    });
    expect(row.revokedAt).not.toBeNull();
  });

  it("a non-admin's inviteId maps to NotFound (NOT Forbidden) — non-disclosure", async () => {
    const owner = await makeUser("Owner");
    const editor = await makeUser("Editor");
    const stranger = await makeUser("Stranger");
    const project = await makeProject(owner.id);
    await addMember(project.id, editor.id, "EDITOR");
    const invite = await mintInvite(owner.id, project.id);

    // An EDITOR member and a complete non-member both get NotFound — the inviteId
    // never oracles the invite's (or project's) existence to a non-admin.
    for (const userId of [editor.id, stranger.id]) {
      await expect(
        revokeInvite(testDb, { userId }, { inviteId: invite.id }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
    // The invite was NOT revoked by the denied attempts.
    const row = await testDb.projectInvite.findUniqueOrThrow({
      where: { id: invite.id },
      select: { revokedAt: true },
    });
    expect(row.revokedAt).toBeNull();
  });

  it("an unknown inviteId throws NotFoundError", async () => {
    const owner = await makeUser("Owner");
    await expect(
      revokeInvite(
        testDb,
        { userId: owner.id },
        { inviteId: "does-not-exist" },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
