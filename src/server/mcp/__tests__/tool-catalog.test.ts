import { beforeEach, describe, expect, it } from "vitest";

import { type Actor } from "~/server/architecture/actor";
import { connectNodes } from "~/server/architecture/edge.service";
import { createNode } from "~/server/architecture/node.service";
import { createProject } from "~/server/architecture/project.service";
import {
  applySpecOutput,
  deleteComponentOutput,
  deleteConnectionOutput,
  restoreComponentOutput,
} from "~/lib/schemas";
import { resetDb, testDb } from "~/server/architecture/__tests__/helpers/test-db";

import { type McpWriteTool, WRITE_TOOLS } from "../tool-catalog";

function descriptorFor(name: string): McpWriteTool {
  const descriptor = WRITE_TOOLS.find((t) => t.name === name);
  if (!descriptor) throw new Error(`${name} descriptor missing`);
  return descriptor;
}

beforeEach(async () => {
  await resetDb();
});

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

describe("WRITE_TOOLS catalog", () => {
  it("registers the apply_spec tool (#67)", () => {
    expect(WRITE_TOOLS.map((t) => t.name)).toContain("apply_spec");
  });

  it("invokes apply_spec end-to-end: structured payload matches the output schema", async () => {
    const user = await testDb.user.create({ data: { name: "Spec owner" } });
    const actor: Actor = { userId: user.id, via: "token", scopes: ["read"] };
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

    const descriptor = WRITE_TOOLS.find((t) => t.name === "apply_spec");
    if (!descriptor) throw new Error("apply_spec descriptor missing");

    // Mirror the SDK registration in `tools.ts`: every tool invoke runs inside
    // `db.$transaction`. Calling the descriptor with a bare client would skip
    // the atomicity envelope `applySpec` depends on (a per-row reject must
    // roll the whole apply back) — the test mirrors production.
    const result = await testDb.$transaction((tx) =>
      descriptor.invoke(tx, actor, {
        ownerNodeId: owner.id,
        kind: "OPENAPI",
        source: PETS_V1,
      }),
    );

    // The structured payload rides on the wire as MCP `structuredContent`
    // (SDK 1.26.0 / ADR-0026 §6 seam). It must satisfy the declared
    // outputSchema so the agent reads a typed object.
    expect(result.structured).toBeDefined();
    const parsed = applySpecOutput.parse(result.structured);
    expect(parsed.ownerNodeId).toBe(owner.id);
    expect(parsed.created).toBe(2); // listPets + createPet
    expect(parsed.overwritten).toBe(0);
    expect(parsed.detached).toBe(0);
    expect(parsed.deleted).toBe(0);
    expect(result.message).toContain(`Component ${owner.id}`);
    expect(result.message).toContain("created 2");
  });

  it("registers the delete/restore tools (#19)", () => {
    const names = WRITE_TOOLS.map((t) => t.name);
    expect(names).toContain("delete_component");
    expect(names).toContain("delete_connection");
    expect(names).toContain("restore_component");
  });

  it("invokes delete_component end-to-end: cascades the subtree and returns the deletionId handle", async () => {
    const user = await testDb.user.create({ data: { name: "Owner" } });
    const actor: Actor = { userId: user.id, via: "token", scopes: ["read"] };
    const project = await createProject(
      testDb,
      { userId: user.id },
      { title: "P" },
    );
    const parent = await createNode(testDb, actor, {
      projectId: project.id,
      title: "Parent",
    });
    const child = await createNode(testDb, actor, {
      projectId: project.id,
      parentId: parent.id,
      title: "Child",
    });

    const result = await testDb.$transaction((tx) =>
      descriptorFor("delete_component").invoke(tx, actor, { id: parent.id }),
    );

    const parsed = deleteComponentOutput.parse(result.structured);
    expect(new Set(parsed.nodeIds)).toEqual(new Set([parent.id, child.id]));
    expect(parsed.deletionId).toBeTruthy();
    expect(result.message).toContain(parsed.deletionId);
    for (const id of [parent.id, child.id]) {
      const row = await testDb.node.findUnique({ where: { id } });
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.deletionId).toBe(parsed.deletionId);
    }
  });

  it("invokes restore_component end-to-end: revives exactly the rows the deletionId stamped", async () => {
    const user = await testDb.user.create({ data: { name: "Owner" } });
    const actor: Actor = { userId: user.id, via: "token", scopes: ["read"] };
    const project = await createProject(
      testDb,
      { userId: user.id },
      { title: "P" },
    );
    const parent = await createNode(testDb, actor, {
      projectId: project.id,
      title: "Parent",
    });
    const child = await createNode(testDb, actor, {
      projectId: project.id,
      parentId: parent.id,
      title: "Child",
    });

    const deleted = deleteComponentOutput.parse(
      (
        await testDb.$transaction((tx) =>
          descriptorFor("delete_component").invoke(tx, actor, { id: parent.id }),
        )
      ).structured,
    );

    const result = await testDb.$transaction((tx) =>
      descriptorFor("restore_component").invoke(tx, actor, {
        deletionId: deleted.deletionId,
      }),
    );

    const parsed = restoreComponentOutput.parse(result.structured);
    expect(new Set(parsed.nodeIds)).toEqual(new Set([parent.id, child.id]));
    for (const id of [parent.id, child.id]) {
      const row = await testDb.node.findUnique({ where: { id } });
      expect(row?.deletedAt).toBeNull();
      expect(row?.deletionId).toBeNull();
    }
  });

  it("invokes delete_connection end-to-end: soft-deletes one Connection with no undo handle", async () => {
    const user = await testDb.user.create({ data: { name: "Owner" } });
    const actor: Actor = { userId: user.id, via: "token", scopes: ["read"] };
    const project = await createProject(
      testDb,
      { userId: user.id },
      { title: "P" },
    );
    const a = await createNode(testDb, actor, {
      projectId: project.id,
      title: "A",
    });
    const b = await createNode(testDb, actor, {
      projectId: project.id,
      title: "B",
    });
    const edge = await connectNodes(testDb, actor, {
      projectId: project.id,
      sourceId: a.id,
      targetId: b.id,
    });

    const result = await testDb.$transaction((tx) =>
      descriptorFor("delete_connection").invoke(tx, actor, { id: edge.id }),
    );

    const parsed = deleteConnectionOutput.parse(result.structured);
    expect(parsed.edgeId).toBe(edge.id);
    const row = await testDb.edge.findUnique({ where: { id: edge.id } });
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletionId).toBeNull();
  });
});
