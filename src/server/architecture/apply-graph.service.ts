import { assertCanWrite } from "./access";
import type { Actor, Db } from "./actor";
import {
  ArchitectureError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from "./errors";
import { connectNodes } from "./edge.service";
import { createNode } from "./node.service";
import {
  applyGraphInput,
  type ApplyGraphInput,
  type ApplyGraphNodeRef,
  type ApplyGraphOutput,
} from "~/lib/schemas";

/**
 * Builds a batch of Components and Connections in one transaction (MCP
 * `apply_graph`, ADR-0026). Composes {@link createNode} and {@link connectNodes}
 * per row inside a single transaction so the whole batch succeeds atomically or
 * rolls back together — no partial graph ever persists.
 *
 * Owner-only: the Project is addressed by `projectId` (an internal handle,
 * never the capability slug — writes are never slug-granted, ADR-0002). The
 * batch authorizes ONCE here; the per-row services re-check (bounded redundancy
 * inside the same transaction; the optimization to extract `*_unauthorized`
 * helpers is named in ADR-0026 for when measurement justifies the seam).
 *
 * Each {@link createNode} / {@link connectNodes} call still scopes parent /
 * endpoint lookups to `project.id`, so a foreign server id surfaces as
 * `NotFoundError` and the entire batch rolls back — no extra authz seam needed
 * for cross-project server-ref protection.
 *
 * Cross-entity validation runs BEFORE any DB write so an agent's corrected
 * retry hits a clean DB:
 *
 * 1. dangling client refs — every `parent` / `source` / `target` that names a
 *    `clientId` must point at a Component in this same batch;
 * 2. parent cycles — `parent` chains must form a DAG (Kahn's topological sort
 *    detects cycles, naming the participating clientIds).
 *
 * Per-row invariants (no self-Connection, no duplicate Edge, parent-existence)
 * are NOT re-implemented — `createNode` and `connectNodes` own them. Reusing
 * them is correctness-by-construction (philosophy #6). A Connection may span
 * scopes (ADR-0028) and carries its own `interaction` (default `ASSOCIATION`).
 *
 * ATOMICITY: this function writes multiple rows. The caller MUST wrap it in
 * `db.$transaction` so a per-row reject rolls back every earlier write in the
 * batch (the MCP tool handler does, like `deleteNode` / `moveNode` /
 * `updatePositions`).
 *
 * Title / label on each row is UNTRUSTED user content, stored verbatim through
 * the underlying services (prompt-injection standing note, CONTEXT.md).
 */
export async function applyGraph(
  db: Db,
  actor: Actor,
  input: ApplyGraphInput,
): Promise<ApplyGraphOutput> {
  const { projectId, components, connections } = applyGraphInput.parse(input);

  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  if (components.length === 0 && connections.length === 0) {
    return { idMap: {}, componentCount: 0, connectionCount: 0 };
  }

  validateNoDanglingClientRefs(components, connections);
  const writeOrder = topologicalSortByParent(components);

  const idMap: Record<string, string> = {};
  for (const componentDraft of writeOrder) {
    const parentId = resolveNodeRef(componentDraft.parent, idMap);
    const node = await createNode(db, actor, {
      projectId: project.id,
      parentId,
      kind: componentDraft.kind,
      title: componentDraft.title,
      posX: componentDraft.posX,
      posY: componentDraft.posY,
    });
    idMap[componentDraft.clientId] = node.id;
  }

  for (const [index, connectionDraft] of connections.entries()) {
    const sourceId = resolveNodeRef(connectionDraft.source, idMap);
    const targetId = resolveNodeRef(connectionDraft.target, idMap);

    if (sourceId === null || targetId === null) {
      throw new ValidationError(
        `Connection at connections[${index}] is missing an endpoint after reference resolution.`,
      );
    }

    try {
      await connectNodes(db, actor, {
        projectId: project.id,
        sourceId,
        targetId,
        interaction: connectionDraft.interaction,
        label: connectionDraft.label,
      });
    } catch (error) {
      throw enrichConnectionError(error, index, connectionDraft);
    }
  }

  return {
    idMap,
    componentCount: components.length,
    connectionCount: connections.length,
  };
}

type ParsedComponent = ReturnType<
  typeof applyGraphInput.parse
>["components"][number];
type ParsedConnection = ReturnType<
  typeof applyGraphInput.parse
>["connections"][number];

function validateNoDanglingClientRefs(
  components: ParsedComponent[],
  connections: ParsedConnection[],
): void {
  const clientIds = new Set(components.map((c) => c.clientId));
  for (const component of components) {
    if (component.parent !== null && component.parent.ref === "client") {
      const ref = component.parent.clientId;
      if (!clientIds.has(ref)) {
        throw new ValidationError(
          `Component "${component.clientId}" references clientId "${ref}" as its parent, but no Component in this batch carries that clientId.`,
        );
      }
    }
  }
  for (const [index, connection] of connections.entries()) {
    for (const slot of ["source", "target"] as const) {
      const ref = connection[slot];
      if (ref?.ref === "client") {
        if (!clientIds.has(ref.clientId)) {
          throw new ValidationError(
            `Connection at connections[${index}] references clientId "${ref.clientId}" as its ${slot}, but no Component in this batch carries that clientId.`,
          );
        }
      }
    }
  }
}

function topologicalSortByParent(
  components: ParsedComponent[],
): ParsedComponent[] {
  const byClientId = new Map(components.map((c) => [c.clientId, c]));
  const dependents = new Map<string, string[]>();
  const remainingDeps = new Map<string, number>();
  for (const component of components) {
    const parent =
      component.parent !== null && component.parent.ref === "client"
        ? component.parent.clientId
        : null;
    remainingDeps.set(component.clientId, parent === null ? 0 : 1);
    if (parent !== null) {
      const list = dependents.get(parent) ?? [];
      list.push(component.clientId);
      dependents.set(parent, list);
    }
  }

  const ready: string[] = [];
  for (const [clientId, deps] of remainingDeps) {
    if (deps === 0) ready.push(clientId);
  }

  const ordered: ParsedComponent[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    const component = byClientId.get(next);
    if (component !== undefined) ordered.push(component);
    for (const dependent of dependents.get(next) ?? []) {
      const remaining = (remainingDeps.get(dependent) ?? 0) - 1;
      remainingDeps.set(dependent, remaining);
      if (remaining === 0) ready.push(dependent);
    }
  }

  if (ordered.length !== components.length) {
    const cycleClientIds: string[] = [];
    for (const component of components) {
      if ((remainingDeps.get(component.clientId) ?? 0) > 0) {
        cycleClientIds.push(component.clientId);
      }
    }
    const named = cycleClientIds.map((id) => `"${id}"`).join(", ");
    throw new ValidationError(
      `Component parent chain has a cycle: ${named} cannot all nest inside each other.`,
    );
  }

  return ordered;
}

function resolveNodeRef(
  ref: ApplyGraphNodeRef | null | undefined,
  idMap: Record<string, string>,
): string | null {
  if (ref === null || ref === undefined) return null;
  if (ref.ref === "server") return ref.id;
  const resolved = idMap[ref.clientId];
  if (resolved === undefined) {
    throw new Error(
      `apply_graph internal error: clientId "${ref.clientId}" was not in the id map at resolution time (should have been caught by validateNoDanglingClientRefs).`,
    );
  }
  return resolved;
}

function enrichConnectionError(
  error: unknown,
  index: number,
  connectionDraft: ParsedConnection,
): unknown {
  if (!(error instanceof ArchitectureError)) return error;

  const conflictingClientIds: string[] = [];
  for (const slot of ["source", "target"] as const) {
    const ref = connectionDraft[slot];
    if (ref?.ref === "client") {
      conflictingClientIds.push(ref.clientId);
    }
  }

  if (error instanceof ConflictError) {
    const existing = error.details ?? {};
    return new ConflictError(error.message, {
      ...existing,
      conflictingClientIds:
        conflictingClientIds.length > 0 ? conflictingClientIds : undefined,
    });
  }

  if (error instanceof ValidationError) {
    return new ValidationError(
      `Connection at connections[${index}]: ${error.message}`,
    );
  }

  return error;
}
