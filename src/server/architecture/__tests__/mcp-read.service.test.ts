import { beforeEach, describe, expect, it } from "vitest";

import { type Actor } from "../actor";
import { exportMarkdownForActor } from "../export.service";
import { ForbiddenError, NotFoundError } from "../errors";
import { createNode } from "../node.service";
import { createProject, listProjects } from "../project.service";
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
  opts: { title?: string; componentTitle?: string; documentation?: string } = {},
) {
  const { title = "My Project", componentTitle = "API Gateway", documentation } =
    opts;
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
    expect(await resolveActorFromToken(testDb, "infdoc_not-a-real-token")).toBeNull();
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

  it("forbids reading another user's project (the headline cross-owner test)", async () => {
    const owner = await makeUser("Owner");
    const intruder = await makeUser("Intruder");
    const { project } = await seedProject(owner.id);

    await expect(
      exportMarkdownForActor(
        testDb,
        { userId: intruder.id, via: "token" },
        { projectId: project.id },
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
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

// `resources/list` enumerates the owner's projects by reusing `listProjects`;
// these pin the isolation invariant #18's read surface depends on.
describe("resources/list isolation (listProjects)", () => {
  it("returns only the actor's own projects", async () => {
    const a = await makeUser("A");
    const b = await makeUser("B");
    await seedProject(a.id, { title: "A1" });
    await seedProject(a.id, { title: "A2" });
    await seedProject(b.id, { title: "B1" });

    const aProjects = await listProjects(testDb, { userId: a.id });
    expect(aProjects.map((p) => p.title).sort()).toEqual(["A1", "A2"]);
  });

  it("returns an empty list for an owner with no projects", async () => {
    const empty = await makeUser("Empty");
    expect(await listProjects(testDb, { userId: empty.id })).toEqual([]);
  });
});
