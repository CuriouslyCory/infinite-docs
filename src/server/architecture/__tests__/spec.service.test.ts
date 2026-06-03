import { beforeEach, describe, expect, it } from "vitest";

import { type Actor } from "../actor";
import { connectNodes } from "../edge.service";
import { createNode } from "../node.service";
import { createProject } from "../project.service";
import { applySpec, previewSpec } from "../spec.service";
import { resetDb, testDb } from "./helpers/test-db";

beforeEach(async () => {
  await resetDb();
});

async function seedOwner() {
  const user = await testDb.user.create({ data: { name: "Owner" } });
  const actor: Actor = { userId: user.id, via: "session" };
  const project = await createProject(
    testDb,
    { userId: user.id },
    { title: "P" },
  );
  const owner = await createNode(testDb, actor, {
    projectId: project.id,
    kind: "EXTERNAL_API",
    title: "Pets API",
  });
  return { actor, project, owner };
}

const PETS_V1 = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Pets", version: "1" },
  paths: {
    "/pets": {
      get: { operationId: "listPets", summary: "List pets" },
      post: { operationId: "createPet", summary: "Create" },
    },
  },
});

const PETS_V2 = JSON.stringify({
  openapi: "3.0.0",
  info: { title: "Pets", version: "2" },
  paths: {
    "/pets": {
      get: { operationId: "listPets", summary: "List the pets (renamed)" },
    },
    "/pets/{id}": {
      delete: { operationId: "deletePet", summary: "Delete" },
    },
  },
});

describe("previewSpec", () => {
  it("returns parseError and writes nothing on bad input", async () => {
    const { actor, owner } = await seedOwner();
    const result = await previewSpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "OPENAPI",
      source: "not json",
    });
    expect(result.parseError).not.toBeNull();
    expect(await testDb.spec.count()).toBe(0);
    expect(await testDb.node.count()).toBe(1); // just the owner
  });

  it("returns new[] on first attach", async () => {
    const { actor, owner } = await seedOwner();
    const result = await previewSpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "OPENAPI",
      source: PETS_V1,
    });
    expect(result.parseError).toBeNull();
    expect(result.hasExistingSpec).toBe(false);
    expect(result.new.map((n) => n.specKey).sort()).toEqual([
      "createPet",
      "listPets",
    ]);
    expect(result.changed).toHaveLength(0);
    expect(result.dropped).toHaveLength(0);
    expect(await testDb.spec.count()).toBe(0);
  });
});

describe("applySpec", () => {
  it("first attach creates children, sets provenance, leaves owner alone", async () => {
    const { actor, owner } = await seedOwner();
    const result = await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "OPENAPI",
      source: PETS_V1,
    });
    expect(result.created).toBe(2);
    expect(result.overwritten + result.detached + result.deleted).toBe(0);

    const spec = await testDb.spec.findFirstOrThrow({
      where: { ownerNodeId: owner.id, deletedAt: null },
    });
    expect(spec.kind).toBe("OPENAPI");

    const children = await testDb.node.findMany({
      where: { sourceSpecId: spec.id, deletedAt: null },
      orderBy: { specKey: "asc" },
    });
    expect(children.map((c) => c.specKey)).toEqual(["createPet", "listPets"]);
    expect(children.every((c) => c.kind === "ENDPOINT")).toBe(true);
    expect(children.every((c) => c.parentId === owner.id)).toBe(true);
  });

  it("re-apply preserves Node id, position, and incident Connections", async () => {
    const { actor, owner } = await seedOwner();
    await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "OPENAPI",
      source: PETS_V1,
    });
    const before = await testDb.node.findFirstOrThrow({
      where: { specKey: "listPets" },
    });
    // Move it and draw a connection to it.
    await testDb.node.update({
      where: { id: before.id },
      data: { posX: 999, posY: 888, documentation: "user-owned docs" },
    });
    const other = await createNode(testDb, actor, {
      projectId: owner.projectId,
      kind: "SERVICE",
      title: "S",
    });
    await connectNodes(testDb, actor, {
      projectId: owner.projectId,
      sourceId: other.id,
      targetId: before.id,
      interaction: "REQUEST",
    });

    // V2: listPets renamed, createPet dropped, deletePet new.
    const preview = await previewSpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "OPENAPI",
      source: PETS_V2,
    });
    expect(preview.hasExistingSpec).toBe(true);
    expect(preview.changed.map((c) => c.specKey)).toEqual(["listPets"]);
    expect(preview.dropped.map((d) => d.specKey)).toEqual(["createPet"]);
    expect(preview.new.map((n) => n.specKey)).toEqual(["deletePet"]);
    // createPet has no incident connections.
    expect(preview.dropped[0]?.hasIncidentConnections).toBe(false);

    const result = await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "OPENAPI",
      source: PETS_V2,
      changed: [
        { specKey: "listPets", action: "overwrite", wipeDocumentation: false },
      ],
      dropped: [{ nodeId: preview.dropped[0]!.nodeId, action: "delete" }],
    });
    expect(result).toMatchObject({ created: 1, overwritten: 1, deleted: 1 });

    const after = await testDb.node.findFirstOrThrow({
      where: { specKey: "listPets", deletedAt: null },
    });
    // Same Node id.
    expect(after.id).toBe(before.id);
    // Position preserved.
    expect(after.posX).toBe(999);
    expect(after.posY).toBe(888);
    // Title overwritten.
    expect(after.title).toBe("List the pets (renamed)");
    // Documentation kept (wipe=false).
    expect(after.documentation).toBe("user-owned docs");
    // Incident connection still live.
    const edge = await testDb.edge.findFirstOrThrow({
      where: { targetId: after.id, deletedAt: null },
    });
    expect(edge.interaction).toBe("REQUEST");
  });

  it("dropped → keep detaches the Component instead of deleting it", async () => {
    const { actor, owner } = await seedOwner();
    await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "OPENAPI",
      source: PETS_V1,
    });
    const preview = await previewSpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "OPENAPI",
      source: PETS_V2,
    });
    const createPet = preview.dropped.find((d) => d.specKey === "createPet")!;

    await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "OPENAPI",
      source: PETS_V2,
      changed: [
        { specKey: "listPets", action: "skip", wipeDocumentation: false },
      ],
      dropped: [{ nodeId: createPet.nodeId, action: "keep" }],
    });

    const node = await testDb.node.findFirstOrThrow({
      where: { id: createPet.nodeId, deletedAt: null },
    });
    expect(node.sourceSpecId).toBeNull();
    expect(node.specKey).toBeNull();
  });

  it("overwrite with wipeDocumentation clears docs", async () => {
    const { actor, owner } = await seedOwner();
    await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "OPENAPI",
      source: PETS_V1,
    });
    const listPets = await testDb.node.findFirstOrThrow({
      where: { specKey: "listPets" },
    });
    await testDb.node.update({
      where: { id: listPets.id },
      data: { documentation: "doomed docs" },
    });

    await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "OPENAPI",
      source: PETS_V2,
      changed: [
        { specKey: "listPets", action: "overwrite", wipeDocumentation: true },
      ],
      // leave deletePet as new + createPet as default-keep
    });

    const after = await testDb.node.findFirstOrThrow({
      where: { id: listPets.id },
    });
    expect(after.documentation).toBe("");
  });

  it("flags dropped Components that have incident connections", async () => {
    const { actor, owner } = await seedOwner();
    await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "OPENAPI",
      source: PETS_V1,
    });
    const createPet = await testDb.node.findFirstOrThrow({
      where: { specKey: "createPet" },
    });
    const peer = await createNode(testDb, actor, {
      projectId: owner.projectId,
      kind: "SERVICE",
      title: "S",
    });
    await connectNodes(testDb, actor, {
      projectId: owner.projectId,
      sourceId: peer.id,
      targetId: createPet.id,
    });

    const preview = await previewSpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "OPENAPI",
      source: PETS_V2,
    });
    const dropped = preview.dropped.find((d) => d.specKey === "createPet")!;
    expect(dropped.hasIncidentConnections).toBe(true);
  });

  it("createNode rejects a sourceSpecId from another Project", async () => {
    const { actor: actorA, owner: ownerA } = await seedOwner();
    await applySpec(testDb, actorA, {
      ownerNodeId: ownerA.id,
      kind: "OPENAPI",
      source: PETS_V1,
    });
    const foreignSpec = await testDb.spec.findFirstOrThrow({
      where: { ownerNodeId: ownerA.id, deletedAt: null },
    });

    // A second owner in a different Project cannot link the foreign Spec.
    const { actor: actorB, owner: ownerB } = await seedOwner();
    await expect(
      createNode(testDb, actorB, {
        projectId: ownerB.projectId,
        parentId: ownerB.id,
        kind: "ENDPOINT",
        title: "smuggled",
        sourceSpecId: foreignSpec.id,
        specKey: "smuggled",
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("reuses the live Spec row on re-attach (no idx_spec_owner_live violation)", async () => {
    const { actor, owner } = await seedOwner();
    await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "OPENAPI",
      source: PETS_V1,
    });
    await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "OPENAPI",
      source: PETS_V2,
    });
    const live = await testDb.spec.findMany({
      where: { ownerNodeId: owner.id, deletedAt: null },
    });
    expect(live).toHaveLength(1);
  });
});

// Post→User, Comment→Post, and a self-referential Comment→Comment (skipped).
const DDL_V1 = `
  CREATE TABLE "User" ( "id" TEXT NOT NULL, CONSTRAINT "User_pkey" PRIMARY KEY ("id") );
  CREATE TABLE "Post" ( "id" TEXT NOT NULL, "authorId" TEXT NOT NULL, CONSTRAINT "Post_pkey" PRIMARY KEY ("id") );
  CREATE TABLE "Comment" ( "id" TEXT NOT NULL, "postId" TEXT NOT NULL, "parentId" TEXT, CONSTRAINT "Comment_pkey" PRIMARY KEY ("id") );
  ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id");
  ALTER TABLE "Comment" ADD CONSTRAINT "Comment_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id");
  ALTER TABLE "Comment" ADD CONSTRAINT "Comment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Comment"("id");
`;

// Same tables, but the Comment→Post FK is gone (Post→User remains).
const DDL_V2 = `
  CREATE TABLE "User" ( "id" TEXT NOT NULL, CONSTRAINT "User_pkey" PRIMARY KEY ("id") );
  CREATE TABLE "Post" ( "id" TEXT NOT NULL, "authorId" TEXT NOT NULL, CONSTRAINT "Post_pkey" PRIMARY KEY ("id") );
  CREATE TABLE "Comment" ( "id" TEXT NOT NULL, "postId" TEXT NOT NULL, CONSTRAINT "Comment_pkey" PRIMARY KEY ("id") );
  ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id");
`;

// The three tables with NO foreign keys — for the slot-adoption test.
const DDL_TABLES_ONLY = `
  CREATE TABLE "User" ( "id" TEXT NOT NULL, CONSTRAINT "User_pkey" PRIMARY KEY ("id") );
  CREATE TABLE "Post" ( "id" TEXT NOT NULL, "authorId" TEXT NOT NULL, CONSTRAINT "Post_pkey" PRIMARY KEY ("id") );
`;

async function seedDbOwner() {
  const user = await testDb.user.create({ data: { name: "Owner" } });
  const actor: Actor = { userId: user.id, via: "session" };
  const project = await createProject(
    testDb,
    { userId: user.id },
    { title: "DB" },
  );
  const owner = await createNode(testDb, actor, {
    projectId: project.id,
    kind: "DATABASE",
    title: "App DB",
  });
  return { actor, project, owner };
}

describe("applySpec — FK connections (#76)", () => {
  it("first attach draws an FK Connection per ordered table pair, with provenance, skipping self-FKs", async () => {
    const { actor, owner } = await seedDbOwner();
    const result = await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "SQL_DDL",
      source: DDL_V1,
    });
    // Post→User and Comment→Post; the self-referential Comment→Comment is skipped.
    expect(result.connectionsCreated).toBe(2);
    expect(result.connectionsRemoved).toBe(0);

    const spec = await testDb.spec.findFirstOrThrow({
      where: { ownerNodeId: owner.id, deletedAt: null },
    });
    const edges = await testDb.edge.findMany({
      where: { sourceSpecId: spec.id, deletedAt: null },
    });
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.interaction === "REQUEST")).toBe(true);

    const byKey = new Map(edges.map((e) => [e.specKey, e]));
    const tables = await testDb.node.findMany({
      where: { sourceSpecId: spec.id, deletedAt: null, kind: "TABLE" },
    });
    const tableId = (title: string) =>
      tables.find((t) => t.title === title)!.id;

    const postUser = byKey.get("Post->User")!;
    expect(postUser.sourceId).toBe(tableId("Post"));
    expect(postUser.targetId).toBe(tableId("User"));
    expect(postUser.label).toBe("authorId");

    expect(byKey.has("Comment->Post")).toBe(true);
    // No self-link Connection was drawn.
    expect(edges.some((e) => e.sourceId === e.targetId)).toBe(false);
  });

  it("re-applying the same spec is idempotent (no duplicate Connections)", async () => {
    const { actor, owner } = await seedDbOwner();
    await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "SQL_DDL",
      source: DDL_V1,
    });
    const again = await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "SQL_DDL",
      source: DDL_V1,
    });
    expect(again.connectionsCreated).toBe(0);
    expect(again.connectionsRemoved).toBe(0);

    const spec = await testDb.spec.findFirstOrThrow({
      where: { ownerNodeId: owner.id, deletedAt: null },
    });
    const edges = await testDb.edge.findMany({
      where: { sourceSpecId: spec.id, deletedAt: null },
    });
    expect(edges).toHaveLength(2);
  });

  it("removes a Connection whose FK vanished from the re-parsed spec", async () => {
    const { actor, owner } = await seedDbOwner();
    await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "SQL_DDL",
      source: DDL_V1,
    });

    const preview = await previewSpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "SQL_DDL",
      source: DDL_V2,
    });
    expect(preview.connectionsToRemove).toBe(1);

    const result = await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "SQL_DDL",
      source: DDL_V2,
      // Comment loses a column on V2 → a CHANGED/dropped child; default-keep is fine.
      dropped: [],
    });
    expect(result.connectionsRemoved).toBe(1);

    const spec = await testDb.spec.findFirstOrThrow({
      where: { ownerNodeId: owner.id, deletedAt: null },
    });
    const live = await testDb.edge.findMany({
      where: { sourceSpecId: spec.id, deletedAt: null },
    });
    expect(live.map((e) => e.specKey)).toEqual(["Post->User"]);
  });

  it("adopts a hand-drawn Connection occupying the same slot instead of duplicating", async () => {
    const { actor, owner } = await seedDbOwner();
    // First attach a spec with tables only (no FKs), then hand-draw Post→User.
    await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "SQL_DDL",
      source: DDL_TABLES_ONLY,
    });
    const post = await testDb.node.findFirstOrThrow({
      where: { specKey: "Post", deletedAt: null },
    });
    const user = await testDb.node.findFirstOrThrow({
      where: { specKey: "User", deletedAt: null },
    });
    const handDrawn = await connectNodes(testDb, actor, {
      projectId: owner.projectId,
      sourceId: post.id,
      targetId: user.id,
      interaction: "REQUEST",
      label: "hand",
    });
    expect(handDrawn.sourceSpecId).toBeNull();

    // Re-apply with the FK present → the existing slot is adopted, not duplicated.
    const result = await applySpec(testDb, actor, {
      ownerNodeId: owner.id,
      kind: "SQL_DDL",
      source: DDL_TABLES_ONLY.replace(
        /;\s*$/,
        `; ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id");`,
      ),
    });
    expect(result.connectionsCreated).toBe(1);

    const postUserEdges = await testDb.edge.findMany({
      where: { sourceId: post.id, targetId: user.id, deletedAt: null },
    });
    // Exactly one edge (adopted, not duplicated), now carrying Spec provenance.
    expect(postUserEdges).toHaveLength(1);
    expect(postUserEdges[0]!.id).toBe(handDrawn.id);
    expect(postUserEdges[0]!.specKey).toBe("Post->User");
    expect(postUserEdges[0]!.sourceSpecId).not.toBeNull();
  });
});
