import { beforeEach, describe, expect, it } from "vitest";

import { type Actor } from "../actor";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "../errors";
import { connectNodes, deleteEdge, restoreEdge } from "../edge.service";
import { addFlow, deleteFlow } from "../flow.service";
import {
  getRoutedFlowIdsForEdge,
  routeFlow,
  unrouteFlow,
} from "../flow-route.service";
import { createNode, deleteNode, getCanvas, restoreNode } from "../node.service";
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

/**
 * Seeds a project with two same-Canvas Components A, B, a Connection A → B,
 * and an INBOUND Flow on B (the API-style scene the Slice 2 plan uses).
 */
async function seedAToB() {
  const user = await makeUser();
  const actor: Actor = { userId: user.id, via: "session" };
  const project = await makeProject(user.id);
  const a = await createNode(testDb, actor, {
    projectId: project.id,
    title: "Web Server",
  });
  const b = await createNode(testDb, actor, {
    projectId: project.id,
    title: "API",
  });
  const edge = await connectNodes(testDb, actor, {
    projectId: project.id,
    sourceId: a.id,
    targetId: b.id,
  });
  const flow = await addFlow(testDb, actor, {
    ownerNodeId: b.id,
    kind: "OPENAPI_OPERATION",
    key: "POST /pets",
    title: "Create a pet",
    polarity: "INBOUND",
  });
  return { user, actor, project, a, b, edge, flow };
}

describe("routeFlow", () => {
  it("happy path: routes a Flow whose owner is the target endpoint", async () => {
    const { actor, edge, flow, project, b } = await seedAToB();

    const route = await routeFlow(testDb, actor, {
      flowId: flow.id,
      outerEdgeId: edge.id,
    });

    expect(route.projectId).toBe(project.id);
    expect(route.flowId).toBe(flow.id);
    expect(route.outerEdgeId).toBe(edge.id);
    expect(route.innerEdgeId).toBeNull();
    expect(route.deletedAt).toBeNull();
    expect(route.deletionId).toBeNull();

    // The Flow's owner (B) is the edge's targetId — sanity check for the
    // owner-touches-endpoint rule.
    expect(b.id).toBe(edge.targetId);
  });

  it("happy path: routes a Flow whose owner is the source endpoint", async () => {
    const { actor, project, a, b } = await seedAToB();
    // Add an OUTBOUND flow on A so its owner matches the source endpoint.
    const flow = await addFlow(testDb, actor, {
      ownerNodeId: a.id,
      kind: "EVENT",
      key: "pet-created",
      title: "Pet created event",
      polarity: "OUTBOUND",
    });
    const edge = await testDb.edge.findFirstOrThrow({
      where: { projectId: project.id, sourceId: a.id, targetId: b.id },
    });

    const route = await routeFlow(testDb, actor, {
      flowId: flow.id,
      outerEdgeId: edge.id,
    });
    expect(route.flowId).toBe(flow.id);
  });

  it("rejects when the Flow's owner is neither endpoint of the outer Edge", async () => {
    const { actor, edge, project } = await seedAToB();
    // A third Component C — not on either end of the A→B edge.
    const c = await createNode(testDb, actor, {
      projectId: project.id,
      title: "C",
    });
    const orphanFlow = await addFlow(testDb, actor, {
      ownerNodeId: c.id,
      kind: "GENERIC",
      key: "noop",
      title: "Detached flow",
      polarity: "INBOUND",
    });

    await expect(
      routeFlow(testDb, actor, {
        flowId: orphanFlow.id,
        outerEdgeId: edge.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("rejects a duplicate active route; allows after unroute", async () => {
    const { actor, edge, flow } = await seedAToB();

    const first = await routeFlow(testDb, actor, {
      flowId: flow.id,
      outerEdgeId: edge.id,
    });

    const dupe = routeFlow(testDb, actor, {
      flowId: flow.id,
      outerEdgeId: edge.id,
    });
    await expect(dupe).rejects.toBeInstanceOf(ConflictError);
    await expect(dupe).rejects.toMatchObject({
      details: { conflictingFlowRouteIds: [first.id] },
    });

    // Unroute and re-route: the partial unique index excludes soft-deleted
    // rows (ADR-0010 precondition c) so re-routing after unroute works.
    await unrouteFlow(testDb, actor, { flowRouteId: first.id });
    const second = await routeFlow(testDb, actor, {
      flowId: flow.id,
      outerEdgeId: edge.id,
    });
    expect(second.id).not.toBe(first.id);
  });

  it("rejects a non-owner attempting to route", async () => {
    const { edge, flow } = await seedAToB();
    const intruder: Actor = { userId: "intruder" };
    await expect(
      routeFlow(testDb, intruder, {
        flowId: flow.id,
        outerEdgeId: edge.id,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects when the Flow and Edge belong to different Projects", async () => {
    const { actor, flow } = await seedAToB();
    // A second project — its edge is in a different project from the flow.
    const otherUser = await makeUser("Other");
    const otherActor: Actor = { userId: otherUser.id, via: "session" };
    const otherProject = await makeProject(otherUser.id, "Other");
    const x = await createNode(testDb, otherActor, {
      projectId: otherProject.id,
      title: "X",
    });
    const y = await createNode(testDb, otherActor, {
      projectId: otherProject.id,
      title: "Y",
    });
    const otherEdge = await connectNodes(testDb, otherActor, {
      projectId: otherProject.id,
      sourceId: x.id,
      targetId: y.id,
    });

    await expect(
      routeFlow(testDb, actor, {
        flowId: flow.id,
        outerEdgeId: otherEdge.id,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("idx_flow_route_dedup backstops the service findFirst (concurrency regression)", async () => {
    const { actor, edge, flow } = await seedAToB();

    // Fire two routeFlow calls in parallel for the same (flowId, edgeId)
    // pair. One must succeed, the other must throw ConflictError — the
    // partial unique index catches whichever racer slips past findFirst.
    // Mirrors the edge.service.test.ts pattern for idx_edge_dedup.
    const results = await Promise.allSettled([
      routeFlow(testDb, actor, { flowId: flow.id, outerEdgeId: edge.id }),
      routeFlow(testDb, actor, { flowId: flow.id, outerEdgeId: edge.id }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(ConflictError);
  });
});

describe("unrouteFlow", () => {
  it("soft-deletes the FlowRoute; idempotent reads as not-found", async () => {
    const { actor, edge, flow } = await seedAToB();
    const route = await routeFlow(testDb, actor, {
      flowId: flow.id,
      outerEdgeId: edge.id,
    });

    const deleted = await unrouteFlow(testDb, actor, {
      flowRouteId: route.id,
    });
    expect(deleted.deletedAt).not.toBeNull();
    // No deletionId on a lone unroute (ADR-0008 lone-delete rule).
    expect(deleted.deletionId).toBeNull();

    await expect(
      unrouteFlow(testDb, actor, { flowRouteId: route.id }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a non-owner", async () => {
    const { actor, edge, flow } = await seedAToB();
    const route = await routeFlow(testDb, actor, {
      flowId: flow.id,
      outerEdgeId: edge.id,
    });
    const intruder: Actor = { userId: "intruder" };
    await expect(
      unrouteFlow(testDb, intruder, { flowRouteId: route.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("deleteEdge cascade for FlowRoutes (Slice 2)", () => {
  it("sweeps incident FlowRoutes with the same deletionId", async () => {
    const { actor, edge, flow, b } = await seedAToB();
    // Three flows on B, all routed onto the same edge.
    const f2 = await addFlow(testDb, actor, {
      ownerNodeId: b.id,
      kind: "OPENAPI_OPERATION",
      key: "GET /pets",
      title: "List pets",
      polarity: "INBOUND",
    });
    const f3 = await addFlow(testDb, actor, {
      ownerNodeId: b.id,
      kind: "OPENAPI_OPERATION",
      key: "GET /pets/{id}",
      title: "Get pet",
      polarity: "INBOUND",
    });
    const r1 = await routeFlow(testDb, actor, {
      flowId: flow.id,
      outerEdgeId: edge.id,
    });
    const r2 = await routeFlow(testDb, actor, {
      flowId: f2.id,
      outerEdgeId: edge.id,
    });
    const r3 = await routeFlow(testDb, actor, {
      flowId: f3.id,
      outerEdgeId: edge.id,
    });

    const result = await testDb.$transaction((tx) =>
      deleteEdge(tx, actor, { id: edge.id }),
    );

    expect(result.deletionId).not.toBeNull();
    expect(result.flowRouteIds).toHaveLength(3);
    expect(new Set(result.flowRouteIds)).toEqual(
      new Set([r1.id, r2.id, r3.id]),
    );

    // All four rows stamped with the same deletionId.
    const stampedEdges = await testDb.edge.findMany({
      where: { deletionId: result.deletionId },
    });
    const stampedRoutes = await testDb.flowRoute.findMany({
      where: { deletionId: result.deletionId },
    });
    expect(stampedEdges).toHaveLength(1);
    expect(stampedRoutes).toHaveLength(3);
  });

  it("lone deleteEdge (no FlowRoutes) still mints no deletionId — ADR-0008 carve-out", async () => {
    const { actor, edge } = await seedAToB();
    // No routeFlow has been called — the edge is bare.
    const result = await testDb.$transaction((tx) =>
      deleteEdge(tx, actor, { id: edge.id }),
    );
    expect(result.deletionId).toBeNull();
    expect(result.flowRouteIds).toHaveLength(0);

    const persisted = await testDb.edge.findUniqueOrThrow({
      where: { id: edge.id },
    });
    expect(persisted.deletedAt).not.toBeNull();
    expect(persisted.deletionId).toBeNull();
  });
});

describe("restoreEdge", () => {
  it("revives the Edge and its swept FlowRoutes as one batch", async () => {
    const { actor, edge, flow } = await seedAToB();
    const route = await routeFlow(testDb, actor, {
      flowId: flow.id,
      outerEdgeId: edge.id,
    });

    const deleted = await testDb.$transaction((tx) =>
      deleteEdge(tx, actor, { id: edge.id }),
    );
    expect(deleted.deletionId).not.toBeNull();

    const restored = await testDb.$transaction((tx) =>
      restoreEdge(tx, actor, { deletionId: deleted.deletionId! }),
    );
    expect(restored.edgeIds).toEqual([edge.id]);
    expect(restored.flowRouteIds).toEqual([route.id]);

    const persistedEdge = await testDb.edge.findUniqueOrThrow({
      where: { id: edge.id },
    });
    expect(persistedEdge.deletedAt).toBeNull();
    expect(persistedEdge.deletionId).toBeNull();
    const persistedRoute = await testDb.flowRoute.findUniqueOrThrow({
      where: { id: route.id },
    });
    expect(persistedRoute.deletedAt).toBeNull();
    expect(persistedRoute.deletionId).toBeNull();
  });

  it("rejects when a live duplicate Edge occupies the slot", async () => {
    const { actor, project, a, b, edge, flow } = await seedAToB();
    await routeFlow(testDb, actor, {
      flowId: flow.id,
      outerEdgeId: edge.id,
    });
    const deleted = await testDb.$transaction((tx) =>
      deleteEdge(tx, actor, { id: edge.id }),
    );
    expect(deleted.deletionId).not.toBeNull();
    // Draw a fresh A → B on the same canvas — occupies the dedupe slot.
    const fresh = await connectNodes(testDb, actor, {
      projectId: project.id,
      sourceId: a.id,
      targetId: b.id,
    });
    await expect(
      testDb.$transaction((tx) =>
        restoreEdge(tx, actor, { deletionId: deleted.deletionId! }),
      ),
    ).rejects.toMatchObject({
      details: { conflictingEdgeIds: [fresh.id] },
    });
  });

  it("not-found on an unknown deletionId", async () => {
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    await expect(
      testDb.$transaction((tx) =>
        restoreEdge(tx, actor, { deletionId: "never-existed" }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("getCanvas.edgeFlows aggregation (Slice 2)", () => {
  it("returns per-edge { total, routed, unrouted, orphan, byKind }", async () => {
    const { actor, edge, flow, b, project } = await seedAToB();
    // A second INBOUND flow on B — total endpoint flows become 2.
    await addFlow(testDb, actor, {
      ownerNodeId: b.id,
      kind: "OPENAPI_OPERATION",
      key: "GET /pets",
      title: "List pets",
      polarity: "INBOUND",
    });
    // Route the first flow only.
    await routeFlow(testDb, actor, {
      flowId: flow.id,
      outerEdgeId: edge.id,
    });

    const canvas = await getCanvas(testDb, null, { slug: project.slug });
    expect(canvas.edgeFlows).toHaveLength(1);
    expect(canvas.edgeFlows[0]).toMatchObject({
      edgeId: edge.id,
      total: 2,
      routed: 1,
      unrouted: 1,
      orphan: 0,
    });
    expect(canvas.edgeFlows[0]?.byKind).toMatchObject({
      OPENAPI_OPERATION: 1,
    });
  });

  it("counts orphan when a routed Flow gets soft-deleted by deleteFlow", async () => {
    const { actor, edge, flow, project } = await seedAToB();
    await routeFlow(testDb, actor, {
      flowId: flow.id,
      outerEdgeId: edge.id,
    });
    await deleteFlow(testDb, actor, { id: flow.id });

    const canvas = await getCanvas(testDb, null, { slug: project.slug });
    expect(canvas.edgeFlows[0]).toMatchObject({
      edgeId: edge.id,
      total: 0, // flow is gone -> no longer counted in endpoint total
      routed: 0,
      orphan: 1,
    });
  });

  it("returns zero entries for edges with neither routes nor endpoint flows", async () => {
    // Two bare components, one connection, no flows anywhere.
    const user = await makeUser();
    const actor: Actor = { userId: user.id, via: "session" };
    const project = await makeProject(user.id);
    const x = await createNode(testDb, actor, {
      projectId: project.id,
      title: "X",
    });
    const y = await createNode(testDb, actor, {
      projectId: project.id,
      title: "Y",
    });
    const edge = await connectNodes(testDb, actor, {
      projectId: project.id,
      sourceId: x.id,
      targetId: y.id,
    });

    const canvas = await getCanvas(testDb, null, { slug: project.slug });
    expect(canvas.edgeFlows).toHaveLength(1);
    expect(canvas.edgeFlows[0]).toMatchObject({
      edgeId: edge.id,
      total: 0,
      routed: 0,
      unrouted: 0,
      orphan: 0,
      byKind: {},
    });
  });

  it("works on the root Canvas — IS NOT DISTINCT FROM handles null canvasNodeId", async () => {
    // A regression for the IS NOT DISTINCT FROM rule in the raw SQL: a
    // plain `=` against null would silently filter all root-canvas edges
    // out and edgeFlows would return [].
    const { actor, edge, flow, project } = await seedAToB();
    await routeFlow(testDb, actor, {
      flowId: flow.id,
      outerEdgeId: edge.id,
    });

    const canvas = await getCanvas(testDb, null, { slug: project.slug });
    const entry = canvas.edgeFlows.find((ef) => ef.edgeId === edge.id);
    expect(entry?.routed).toBe(1);
  });
});

describe("deleteNode cascade absorbs FlowRoutes (Slice 2)", () => {
  it("sweeps FlowRoutes incident to a deleted Component's edges + flows", async () => {
    const { actor, edge, flow, b } = await seedAToB();
    const route = await routeFlow(testDb, actor, {
      flowId: flow.id,
      outerEdgeId: edge.id,
    });

    // Delete the owner Component (B). The cascade must stamp:
    //   - the B Node
    //   - the A→B Edge (incident via targetId)
    //   - the Flow on B (owner sweep)
    //   - the FlowRoute (incident via outerEdgeId AND via flowId)
    const result = await testDb.$transaction((tx) =>
      deleteNode(tx, actor, { id: b.id }),
    );
    expect(result.flowRouteIds).toEqual([route.id]);
    const stamped = await testDb.flowRoute.findUniqueOrThrow({
      where: { id: route.id },
    });
    expect(stamped.deletionId).toBe(result.deletionId);
    expect(stamped.deletedAt).not.toBeNull();
  });

  it("restoreNode pre-checks FlowRoute conflicts", async () => {
    const { actor, edge, flow, b } = await seedAToB();
    const route = await routeFlow(testDb, actor, {
      flowId: flow.id,
      outerEdgeId: edge.id,
    });
    const result = await testDb.$transaction((tx) =>
      deleteNode(tx, actor, { id: b.id }),
    );
    // After the Component delete, route is soft-deleted with this deletionId.
    expect(result.flowRouteIds).toEqual([route.id]);

    // Restore brings it back as a unit — no conflicts (nothing else lives
    // in the (outerEdgeId, flowId) slot).
    const restored = await testDb.$transaction((tx) =>
      restoreNode(tx, actor, { deletionId: result.deletionId }),
    );
    expect(restored.flowRouteIds).toEqual([route.id]);
    const revived = await testDb.flowRoute.findUniqueOrThrow({
      where: { id: route.id },
    });
    expect(revived.deletedAt).toBeNull();
  });
});

describe("getRoutedFlowIdsForEdge (popover helper)", () => {
  it("returns active routed flowIds on the edge", async () => {
    const { actor, edge, flow, project, b } = await seedAToB();
    const f2 = await addFlow(testDb, actor, {
      ownerNodeId: b.id,
      kind: "OPENAPI_OPERATION",
      key: "GET /pets",
      title: "List pets",
      polarity: "INBOUND",
    });
    await routeFlow(testDb, actor, { flowId: flow.id, outerEdgeId: edge.id });
    await routeFlow(testDb, actor, { flowId: f2.id, outerEdgeId: edge.id });

    const ids = await getRoutedFlowIdsForEdge(testDb, null, {
      outerEdgeId: edge.id,
      slug: project.slug,
    });
    expect(new Set(ids)).toEqual(new Set([flow.id, f2.id]));
  });

  it("excludes soft-deleted routes", async () => {
    const { actor, edge, flow, project } = await seedAToB();
    const route = await routeFlow(testDb, actor, {
      flowId: flow.id,
      outerEdgeId: edge.id,
    });
    await unrouteFlow(testDb, actor, { flowRouteId: route.id });
    const ids = await getRoutedFlowIdsForEdge(testDb, null, {
      outerEdgeId: edge.id,
      slug: project.slug,
    });
    expect(ids).toEqual([]);
  });

  it("rejects cross-project: edge not in slug's project surfaces as not-found", async () => {
    const { edge } = await seedAToB();
    // Different project's slug.
    const otherUser = await makeUser("Other");
    const otherProject = await makeProject(otherUser.id, "Other");
    await expect(
      getRoutedFlowIdsForEdge(testDb, null, {
        outerEdgeId: edge.id,
        slug: otherProject.slug,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
