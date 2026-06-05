import { beforeEach, describe, expect, it } from "vitest";

import { type Actor } from "../actor";
import { exportMarkdownForActor } from "../export.service";
import { ForbiddenError, NotFoundError } from "../errors";
import { createNode } from "../node.service";
import {
  createProject,
  listProjects,
  listProjectsForActor,
} from "../project.service";
import {
  createApiToken,
  resolveActorFromToken,
  revokeApiToken,
} from "../token.service";
import { resetDb, testDb } from "./helpers/test-db";

// The token resolver HMACs with the pepper, so `API_TOKEN_PEPPER` must be set in
// .env.test (loaded by setup-env.ts) — the same requirement as the mint tests.

beforeEach(async () => {
  await resetDb();
});

function makeUser(name = "Owner") {
  return testDb.user.create({ data: { name } });
}

async function seedProject(
  ownerId: string,
  opts: {
    title?: string;
    componentTitle?: string;
    documentation?: string;
  } = {},
) {
  const {
    title = "My Project",
    componentTitle = "API Gateway",
    documentation,
  } = opts;
  const actor: Actor = { userId: ownerId };
  const project = await createProject(testDb, actor, { title });
  const node = await createNode(testDb, actor, {
    projectId: project.id,
    title: componentTitle,
  });
  if (documentation) {
    await testDb.node.update({
      where: { id: node.id },
      data: { documentation },
    });
  }
  return { project, node };
}

describe("resolveActorFromToken", () => {
  it("resolves a live token to a token-Actor (authz still by userId)", async () => {
    const user = await makeUser();
    const { token } = await createApiToken(
      testDb,
      { userId: user.id },
      { expiresInDays: 90 },
    );

    const actor = await resolveActorFromToken(testDb, token);

    expect(actor).toEqual({
      userId: user.id,
      via: "token",
      scopes: ["read"],
    });
  });

  // Every rejection path returns the SAME `null` — the adapter maps it to one
  // indistinguishable 401, never disclosing which check failed (ADR-0002).
  it("rejects an absent token", async () => {
    expect(await resolveActorFromToken(testDb, undefined)).toBeNull();
    expect(await resolveActorFromToken(testDb, null)).toBeNull();
    expect(await resolveActorFromToken(testDb, "")).toBeNull();
  });

  it("rejects an unknown token", async () => {
    expect(
      await resolveActorFromToken(testDb, "infdoc_not-a-real-token"),
    ).toBeNull();
  });

  it("rejects a revoked token", async () => {
    const user = await makeUser();
    const { token, apiToken } = await createApiToken(
      testDb,
      { userId: user.id },
      { expiresInDays: 90 },
    );
    await revokeApiToken(testDb, { userId: user.id }, { id: apiToken.id });

    expect(await resolveActorFromToken(testDb, token)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const user = await makeUser();
    const { token, apiToken } = await createApiToken(
      testDb,
      { userId: user.id },
      { expiresInDays: 30 },
    );
    // Backdate the stored expiry to the past — the resolver must reject it.
    await testDb.apiToken.update({
      where: { id: apiToken.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await resolveActorFromToken(testDb, token)).toBeNull();
  });
});

describe("exportMarkdownForActor", () => {
  it("renders the owner's own project as full markdown, docs included", async () => {
    const owner = await makeUser();
    const { project } = await seedProject(owner.id, {
      title: "Billing",
      componentTitle: "Stripe",
      documentation: "SecretDocBody",
    });

    const { markdown } = await exportMarkdownForActor(
      testDb,
      { userId: owner.id, via: "token" },
      { projectId: project.id },
    );

    expect(markdown).toContain("Billing");
    expect(markdown).toContain("Stripe");
    expect(markdown).toContain("SecretDocBody");
  });

  it("omits documentation bodies in index mode", async () => {
    const owner = await makeUser();
    const { project } = await seedProject(owner.id, {
      componentTitle: "Stripe",
      documentation: "SecretDocBody",
    });

    const { markdown } = await exportMarkdownForActor(
      testDb,
      { userId: owner.id, via: "token" },
      { projectId: project.id, mode: "index" },
    );

    expect(markdown).toContain("Stripe");
    expect(markdown).not.toContain("SecretDocBody");
  });

  // Member parity (#109): an EDITOR member reads the project's markdown — the
  // headline parity test. Read needs only `view`, which EDITOR (rank 2) clears.
  it("renders a project for an EDITOR member", async () => {
    const owner = await makeUser("Owner");
    const member = await makeUser("Member");
    const { project } = await seedProject(owner.id, {
      title: "Shared",
      componentTitle: "Worker",
    });
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: member.id, role: "EDITOR" },
    });

    const { markdown } = await exportMarkdownForActor(
      testDb,
      { userId: member.id, via: "token" },
      { projectId: project.id },
    );

    expect(markdown).toContain("Shared");
    expect(markdown).toContain("Worker");
  });

  it("renders a project for a VIEWER member", async () => {
    const owner = await makeUser("Owner");
    const member = await makeUser("Member");
    const { project } = await seedProject(owner.id, {
      componentTitle: "Worker",
    });
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: member.id, role: "VIEWER" },
    });

    const { markdown } = await exportMarkdownForActor(
      testDb,
      { userId: member.id, via: "token" },
      { projectId: project.id },
    );

    expect(markdown).toContain("Worker");
  });

  it("renders a project for an ADMIN member", async () => {
    const owner = await makeUser("Owner");
    const member = await makeUser("Member");
    const { project } = await seedProject(owner.id, {
      componentTitle: "Worker",
    });
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: member.id, role: "ADMIN" },
    });

    const { markdown } = await exportMarkdownForActor(
      testDb,
      { userId: member.id, via: "token" },
      { projectId: project.id },
    );

    expect(markdown).toContain("Worker");
  });

  // Deny → NotFoundError (non-disclosure): a non-member token cannot distinguish
  // a project it may not read from one that does not exist (ADR-0002/0040, #109).
  it("reports another user's project as not-found (the headline cross-owner test)", async () => {
    const owner = await makeUser("Owner");
    const intruder = await makeUser("Intruder");
    const { project } = await seedProject(owner.id);

    await expect(
      exportMarkdownForActor(
        testDb,
        { userId: intruder.id, via: "token" },
        { projectId: project.id },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // Q1 pin: MCP reads now grant via MEMBERSHIP but NEVER via the public guest
  // grant. `guestAccess` is forced to NONE on the token path, so a
  // guestAccess=VIEW project (the default — `seedProject` leaves it VIEW) is
  // still not-found to a non-member token actor (#109). A leaked token must not
  // become a near-universal read key.
  it("does NOT grant a non-member token actor access via guestAccess=VIEW", async () => {
    const owner = await makeUser("Owner");
    const intruder = await makeUser("Intruder");
    const { project } = await seedProject(owner.id);
    // Make the project explicitly public-readable on the web; MCP must ignore it.
    await testDb.project.update({
      where: { id: project.id },
      data: { guestAccess: "VIEW" },
    });

    await expect(
      exportMarkdownForActor(
        testDb,
        { userId: intruder.id, via: "token" },
        { projectId: project.id },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reports a soft-deleted project as not-found", async () => {
    const owner = await makeUser();
    const { project } = await seedProject(owner.id);
    await testDb.project.update({
      where: { id: project.id },
      data: { deletedAt: new Date() },
    });

    await expect(
      exportMarkdownForActor(
        testDb,
        { userId: owner.id, via: "token" },
        { projectId: project.id },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reports an unknown project id as not-found", async () => {
    const owner = await makeUser();

    await expect(
      exportMarkdownForActor(
        testDb,
        { userId: owner.id, via: "token" },
        { projectId: "does-not-exist" },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("renders an owned subtree but never a node from another project", async () => {
    const owner = await makeUser();
    const actor: Actor = { userId: owner.id, via: "token" };
    const { project, node } = await seedProject(owner.id, {
      componentTitle: "Service",
    });

    const { markdown } = await exportMarkdownForActor(testDb, actor, {
      projectId: project.id,
      canvasNodeId: node.id,
    });
    expect(markdown).toContain("Service");

    // A node id from a different project, even one the actor owns, cannot be
    // read through THIS project's scope: the subtree CTE binds projectId, so it
    // returns zero rows → not-found (no cross-project leak).
    const otherSeed = await seedProject(owner.id, {
      title: "Other",
      componentTitle: "Other Service",
    });
    await expect(
      exportMarkdownForActor(testDb, actor, {
        projectId: project.id,
        canvasNodeId: otherSeed.node.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

// `resources/list` enumerates the actor's owner-or-member projects via
// `listProjectsForActor` (#109); these pin the isolation invariant the read
// surface depends on (enumeration === member-aware read grant).
describe("resources/list isolation (listProjectsForActor)", () => {
  // The Q2 pin: enumeration includes owned + member projects, and never leaks a
  // project the actor neither owns nor is a member of.
  it("returns the actor's owned AND member projects, but no others", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    await seedProject(a.id, { title: "A1" });
    const { project: b1 } = await seedProject(b.id, { title: "B1" });
    await seedProject(b.id, { title: "B2" });
    // A is a VIEWER member of B1 (but not B2).
    await testDb.projectMembership.create({
      data: { projectId: b1.id, userId: a.id, role: "VIEWER" },
    });

    const aProjects = await listProjectsForActor(testDb, { userId: a.id });
    expect(aProjects.map((p) => p.title).sort()).toEqual(["A1", "B1"]);

    // B's membership-less view is unchanged: B's owned set, no A1.
    const bProjects = await listProjectsForActor(testDb, { userId: b.id });
    expect(bProjects.map((p) => p.title).sort()).toEqual(["B1", "B2"]);
  });

  it("excludes a soft-deleted member project", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    const { project: b1 } = await seedProject(b.id, { title: "B1" });
    await testDb.projectMembership.create({
      data: { projectId: b1.id, userId: a.id, role: "EDITOR" },
    });
    await testDb.project.update({
      where: { id: b1.id },
      data: { deletedAt: new Date() },
    });

    expect(await listProjectsForActor(testDb, { userId: a.id })).toEqual([]);
  });

  it("returns an empty list for an actor with no owned or member projects", async () => {
    const empty = await makeUser("Empty");
    expect(await listProjectsForActor(testDb, { userId: empty.id })).toEqual(
      [],
    );
  });
});

// Guard the surgical split (#109): the web dashboard's `listProjects` stays
// OWNER-ONLY. Widening it would ship a broken member-card delete button (delete
// is owner-gated), so a membership must NOT make a project appear here.
describe("web listProjects stays owner-only (surgical-split guard)", () => {
  it("returns only the actor's own projects", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    await seedProject(a.id, { title: "A1" });
    await seedProject(a.id, { title: "A2" });
    await seedProject(b.id, { title: "B1" });

    const aProjects = await listProjects(testDb, { userId: a.id });
    expect(aProjects.map((p) => p.title).sort()).toEqual(["A1", "A2"]);
  });

  it("does NOT include a project the actor is only a member of", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    await seedProject(a.id, { title: "A1" });
    const { project: b1 } = await seedProject(b.id, { title: "B1" });
    await testDb.projectMembership.create({
      data: { projectId: b1.id, userId: a.id, role: "EDITOR" },
    });

    const aProjects = await listProjects(testDb, { userId: a.id });
    expect(aProjects.map((p) => p.title)).toEqual(["A1"]);
  });

  it("returns an empty list for an owner with no projects", async () => {
    const empty = await makeUser("Empty");
    expect(await listProjects(testDb, { userId: empty.id })).toEqual([]);
  });
});

// Write parity (#109 confirms, #104 delivered): MCP write tools route through
// the `authorizeProjectWrite(…, "edit")`-gated services, so a VIEWER token is
// blocked and an EDITOR token succeeds — proving no MCP-layer write bypass.
describe("MCP write tools inherit the capability gate", () => {
  it("blocks a VIEWER member from creating a component (deny is ForbiddenError at the service gate)", async () => {
    const owner = await makeUser("Owner");
    const viewer = await makeUser("Viewer");
    const { project } = await seedProject(owner.id);
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: viewer.id, role: "VIEWER" },
    });

    await expect(
      createNode(
        testDb,
        { userId: viewer.id, via: "token" },
        { projectId: project.id, title: "Blocked" },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("lets an EDITOR member create a component", async () => {
    const owner = await makeUser("Owner");
    const editor = await makeUser("Editor");
    const { project } = await seedProject(owner.id);
    await testDb.projectMembership.create({
      data: { projectId: project.id, userId: editor.id, role: "EDITOR" },
    });

    const node = await createNode(
      testDb,
      { userId: editor.id, via: "token" },
      { projectId: project.id, title: "Allowed" },
    );

    expect(node.title).toBe("Allowed");
  });
});
