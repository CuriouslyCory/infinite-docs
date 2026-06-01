import { randomUUID } from "node:crypto";

import {
  type Flow,
  type FlowSpec,
  type FlowKind as PrismaFlowKind,
  type FlowInteraction as PrismaFlowInteraction,
  type FlowSpecKind as PrismaFlowSpecKind,
} from "../../../generated/prisma/client";
import { assertCanRead, assertCanWrite } from "./access";
import type { Actor, Db } from "./actor";
import { ConflictError, NotFoundError, ValidationError } from "./errors";
import { parseFlowSpec, type ParsedFlow } from "./flow-parser";
import {
  FLOW_PALETTE_PAGE_SIZE,
  type FlowPaletteItem,
} from "./node.service";
import { isFlowDedupCollision } from "./prisma-errors";
import {
  addFlowInput,
  attachFlowSpecInput,
  deleteFlowInput,
  getFlowPaletteInput,
  getFlowsForNodeInput,
  updateFlowInput,
  type AddFlowInput,
  type AttachFlowSpecInput,
  type DeleteFlowInput,
  type FlowInteraction,
  type FlowKind,
  type FlowSpecKind,
  type GetFlowPaletteInput,
  type GetFlowsForNodeInput,
  type UpdateFlowInput,
} from "~/lib/schemas";

// Compile-time parity guards (mirror node.service.ts:35-52): the client-safe
// Zod enums (~/lib/schemas) and the Prisma enums must describe the same value
// set. If either side gains or loses a member, one of these typed maps stops
// type-checking and `pnpm check` fails — turning "keep the two enums in sync"
// from a remembered discipline into a checked invariant (ADR-0011).
const _zodFlowKindIsPrisma: Record<FlowKind, PrismaFlowKind> = {
  GENERIC: "GENERIC",
  OPENAPI_OPERATION: "OPENAPI_OPERATION",
  GRAPHQL_FIELD: "GRAPHQL_FIELD",
  ASYNCAPI_CHANNEL: "ASYNCAPI_CHANNEL",
  SSE_STREAM: "SSE_STREAM",
  WEBSOCKET: "WEBSOCKET",
  FUNCTION_CALL: "FUNCTION_CALL",
  EVENT: "EVENT",
  DB_TABLE: "DB_TABLE",
};
const _prismaFlowKindIsZod: Record<PrismaFlowKind, FlowKind> = {
  GENERIC: "GENERIC",
  OPENAPI_OPERATION: "OPENAPI_OPERATION",
  GRAPHQL_FIELD: "GRAPHQL_FIELD",
  ASYNCAPI_CHANNEL: "ASYNCAPI_CHANNEL",
  SSE_STREAM: "SSE_STREAM",
  WEBSOCKET: "WEBSOCKET",
  FUNCTION_CALL: "FUNCTION_CALL",
  EVENT: "EVENT",
  DB_TABLE: "DB_TABLE",
};
const _zodFlowSpecKindIsPrisma: Record<FlowSpecKind, PrismaFlowSpecKind> = {
  OPENAPI: "OPENAPI",
  ASYNCAPI: "ASYNCAPI",
  TS_SIGNATURE: "TS_SIGNATURE",
  GRAPHQL: "GRAPHQL",
  SQL_DDL: "SQL_DDL",
  CUSTOM: "CUSTOM",
};
const _prismaFlowSpecKindIsZod: Record<PrismaFlowSpecKind, FlowSpecKind> = {
  OPENAPI: "OPENAPI",
  ASYNCAPI: "ASYNCAPI",
  TS_SIGNATURE: "TS_SIGNATURE",
  GRAPHQL: "GRAPHQL",
  SQL_DDL: "SQL_DDL",
  CUSTOM: "CUSTOM",
};
const _zodFlowInteractionIsPrisma: Record<
  FlowInteraction,
  PrismaFlowInteraction
> = {
  REQUEST: "REQUEST",
  PUSH: "PUSH",
  SUBSCRIBE: "SUBSCRIBE",
  DUPLEX: "DUPLEX",
};
const _prismaFlowInteractionIsZod: Record<
  PrismaFlowInteraction,
  FlowInteraction
> = {
  REQUEST: "REQUEST",
  PUSH: "PUSH",
  SUBSCRIBE: "SUBSCRIBE",
  DUPLEX: "DUPLEX",
};
void _zodFlowKindIsPrisma;
void _prismaFlowKindIsZod;
void _zodFlowSpecKindIsPrisma;
void _prismaFlowSpecKindIsZod;
void _zodFlowInteractionIsPrisma;
void _prismaFlowInteractionIsZod;

export interface AttachFlowSpecResult {
  flowSpec: FlowSpec;
  flowCount: number;
  parseError: string | null;
}

/**
 * Attaches (or re-attaches) a FlowSpec to a Component and reconciles its
 * derived Flow rows. The load-bearing service of Slice 1.
 *
 * Six invariants packed into one entry point — the docstring is here because
 * a future reader cannot infer them from the call shape:
 *
 * 1. **Parse-on-write.** `parseFlowSpec` runs server-side; the OpenAPI body
 *    never travels with a Canvas read. The parser is a bounded loader (size +
 *    depth + operation caps) so a hostile spec cannot OOM
 *    (prompt-injection standing note, parse-time clause; ADR-0011).
 * 2. **Malformed never throws.** A parse failure stores `parseError`, creates
 *    zero Flows, leaves prior Flows as-is. The caller sees a successful
 *    response with `flowCount` unchanged.
 * 3. **Non-destructive re-parse.** Matching `key`s preserved (rows untouched);
 *    new `key`s inserted; dropped `key`s soft-deleted with a FRESH
 *    `deletionId` per re-parse batch. Wiring downstream of a renamed
 *    operation orphans visibly rather than vanishing silently. The minted
 *    `deletionId` is a grouping handle, not a `restoreNode`-restorable batch
 *    — `restoreNode` is owned by `deleteNode`; orphan re-parse ids return
 *    zero rows (harmless).
 * 4. **`source` is untrusted.** Stored verbatim, parsed only by the bounded
 *    loader. Never interpolated, never near an LLM prompt (the standing note's
 *    output boundary is a later milestone).
 * 5. **De-dupe is service-primary, index-backstopped.** A new Flow `key` that
 *    collides with an active row throws `ConflictError` with
 *    `details.conflictingFlowIds`. ADR-0010 named pattern, ADR-0011 adopter.
 * 6. **Owner-only.** `ownerNodeId` is loaded and its Project authorized
 *    through `assertCanWrite`. Writes are never granted by capability slug
 *    (ADR-0002).
 *
 * Runs inside the caller's transaction (the router wraps it in
 * `db.$transaction`), so the upsert + reconciliation commit atomically.
 */
export async function attachFlowSpec(
  db: Db,
  actor: Actor,
  input: AttachFlowSpecInput,
): Promise<AttachFlowSpecResult> {
  const { ownerNodeId, kind, source } = attachFlowSpecInput.parse(input);

  const node = await db.node.findFirst({
    where: { id: ownerNodeId, deletedAt: null },
    select: { id: true, projectId: true },
  });
  if (!node) {
    throw new NotFoundError();
  }
  const project = await db.project.findFirst({
    where: { id: node.projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  const parsed = parseFlowSpec(kind, source);
  const parseError = "parseError" in parsed ? parsed.parseError : null;
  const parsedFlows = "flows" in parsed ? parsed.flows : null;

  const flowSpec = await db.flowSpec.upsert({
    where: { ownerNodeId: node.id },
    create: {
      projectId: node.projectId,
      ownerNodeId: node.id,
      kind,
      source,
      parsedAt: parsedFlows ? new Date() : null,
      parseError,
    },
    update: {
      kind,
      source,
      parsedAt: parsedFlows ? new Date() : null,
      parseError,
      deletedAt: null,
      deletionId: null,
    },
  });

  if (!parsedFlows) {
    const existing = await db.flow.count({
      where: { ownerNodeId: node.id, deletedAt: null },
    });
    return { flowSpec, flowCount: existing, parseError };
  }

  await reconcileDerivedFlows(db, {
    projectId: node.projectId,
    ownerNodeId: node.id,
    flowSpecId: flowSpec.id,
    incoming: parsedFlows,
  });

  // Count the reconciled active set, not `parsedFlows.length` — hand-authored
  // Flows (sourceSpecId === null) survive a re-parse, so the pill would
  // undercount on any Component that owns one.
  const flowCount = await db.flow.count({
    where: { ownerNodeId: node.id, deletedAt: null },
  });

  return {
    flowSpec,
    flowCount,
    parseError,
  };
}

interface ReconcileArgs {
  projectId: string;
  ownerNodeId: string;
  flowSpecId: string;
  incoming: ParsedFlow[];
}

async function reconcileDerivedFlows(
  db: Db,
  { projectId, ownerNodeId, flowSpecId, incoming }: ReconcileArgs,
): Promise<void> {
  const existing = await db.flow.findMany({
    where: { ownerNodeId, deletedAt: null },
    select: { id: true, key: true, sourceSpecId: true },
  });
  const existingByKey = new Map(existing.map((f) => [f.key, f]));
  const incomingByKey = new Map(incoming.map((f) => [f.key, f]));

  // Drop set: existing derived (i.e. previously from this spec) keys not
  // present in the new parse. Hand-authored Flows (sourceSpecId === null) are
  // never swept by a re-parse — they belong to the user, not the spec.
  const dropIds = existing
    .filter(
      (f) => f.sourceSpecId !== null && !incomingByKey.has(f.key),
    )
    .map((f) => f.id);

  if (dropIds.length > 0) {
    const deletionId = randomUUID();
    await db.flow.updateMany({
      where: { id: { in: dropIds }, deletedAt: null },
      data: { deletedAt: new Date(), deletionId },
    });
  }

  // Insert set: incoming keys not present in any active row for this owner.
  // A matching existing key — derived OR hand-authored — is preserved as-is;
  // we do not overwrite a user's hand-authored Flow whose key happened to
  // match a spec operation.
  const insertFlows = incoming.filter((f) => !existingByKey.has(f.key));
  for (const flow of insertFlows) {
    try {
      await db.flow.create({
        data: {
          projectId,
          ownerNodeId,
          sourceSpecId: flowSpecId,
          kind: flow.kind,
          key: flow.key,
          title: flow.title,
          interaction: flow.interaction,
          signature: flow.signature as never,
        },
      });
    } catch (error) {
      if (!isFlowDedupCollision(error)) throw error;
      const racer = await db.flow.findFirst({
        where: { ownerNodeId, key: flow.key, deletedAt: null },
        select: { id: true },
      });
      throw new ConflictError(
        `Flow "${flow.key}" already exists on this Component.`,
        { conflictingFlowIds: racer ? [racer.id] : [] },
      );
    }
  }
}

/**
 * Adds a user-authored Flow (no FlowSpec) to a Component. The same
 * service-primary + index-backstop de-dupe pattern `connectNodes` uses for
 * Edge (ADR-0010 named pattern; ADR-0011 adopter): the fast-path `findFirst`
 * throws the readable conflict; the partial unique index `idx_flow_dedup`
 * catches the concurrent racer, both translated to the same `ConflictError`
 * shape with `details.conflictingFlowIds`. Owner-only via the owner Node's
 * Project. `title` is UNTRUSTED user content, stored verbatim
 * (prompt-injection standing note).
 */
export async function addFlow(
  db: Db,
  actor: Actor,
  input: AddFlowInput,
): Promise<Flow> {
  const { ownerNodeId, kind, key, title, interaction } =
    addFlowInput.parse(input);

  const node = await db.node.findFirst({
    where: { id: ownerNodeId, deletedAt: null },
    select: { id: true, projectId: true },
  });
  if (!node) {
    throw new NotFoundError();
  }
  const project = await db.project.findFirst({
    where: { id: node.projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  const duplicate = await db.flow.findFirst({
    where: { ownerNodeId: node.id, key, deletedAt: null },
    select: { id: true },
  });
  if (duplicate) {
    throw new ConflictError(`Flow "${key}" already exists on this Component.`, {
      conflictingFlowIds: [duplicate.id],
    });
  }

  try {
    return await db.flow.create({
      data: {
        projectId: node.projectId,
        ownerNodeId: node.id,
        sourceSpecId: null,
        kind,
        key,
        title,
        interaction,
      },
    });
  } catch (error) {
    if (!isFlowDedupCollision(error)) throw error;
    const racer = await db.flow.findFirst({
      where: { ownerNodeId: node.id, key, deletedAt: null },
      select: { id: true },
    });
    throw new ConflictError(`Flow "${key}" already exists on this Component.`, {
      conflictingFlowIds: racer ? [racer.id] : [],
    });
  }
}

/**
 * Edits a Flow's `title`, `interaction`, or `signature`. Spec-derived Flows
 * (`sourceSpecId !== null`) reject — the spec is the source of truth; edit
 * the spec and re-paste to change derived Flows (ADR-0011). `interaction` is
 * editable (it drives the Flow's arrow direction; ADR-0023); `key`/`kind` stay
 * non-editable (memory: "prefer narrow required inputs"). `title` is UNTRUSTED
 * (prompt-injection standing note). Owner-only.
 */
export async function updateFlow(
  db: Db,
  actor: Actor,
  input: UpdateFlowInput,
): Promise<Flow> {
  const { id, title, interaction, signature } = updateFlowInput.parse(input);

  const flow = await db.flow.findFirst({ where: { id, deletedAt: null } });
  if (!flow) {
    throw new NotFoundError();
  }
  const project = await db.project.findFirst({
    where: { id: flow.projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  if (flow.sourceSpecId !== null) {
    throw new ValidationError(
      "This Flow is derived from a spec. Edit the spec and re-paste to change it.",
    );
  }

  return db.flow.update({
    where: { id: flow.id },
    data: {
      ...(title !== undefined ? { title } : {}),
      ...(interaction !== undefined ? { interaction } : {}),
      ...(signature !== undefined ? { signature: signature as never } : {}),
    },
  });
}

/**
 * Removes a Flow via soft-delete. Idempotent in spirit: an already-deleted
 * Flow reads as not-found. A lone `deleteFlow` does NOT mint a `deletionId` —
 * that handle ties cascading-batch deletes only (ADR-0008). Owner-only.
 */
export async function deleteFlow(
  db: Db,
  actor: Actor,
  input: DeleteFlowInput,
): Promise<Flow> {
  const { id } = deleteFlowInput.parse(input);

  const flow = await db.flow.findFirst({ where: { id, deletedAt: null } });
  if (!flow) {
    throw new NotFoundError();
  }
  const project = await db.project.findFirst({
    where: { id: flow.projectId, deletedAt: null },
    select: { ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

  return db.flow.update({
    where: { id: flow.id },
    data: { deletedAt: new Date() },
  });
}

/**
 * Reads a Component's active Flow palette. Addressed by the capability slug
 * (the read grant, ADR-0002), so the panel works for viewers without a
 * session as long as they know the project's URL; the `ownerNodeId` is
 * confirmed to belong to that Project before reading. Bounded to the first
 * 200 rows by createdAt; cursor pagination is additive future work.
 */
export async function getFlowsForNode(
  db: Db,
  actor: Actor | null,
  input: GetFlowsForNodeInput,
): Promise<Flow[]> {
  const { ownerNodeId, slug } = getFlowsForNodeInput.parse(input);

  const project = await db.project.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }

  // Possession of the slug is the read grant (ADR-0002); the read still must
  // confirm the requested Component lives in that Project so a slug for one
  // project cannot be used to read Flows from another.
  assertCanRead(actor, project, { viaCapabilitySlug: true });

  const node = await db.node.findFirst({
    where: { id: ownerNodeId, projectId: project.id, deletedAt: null },
    select: { id: true },
  });
  if (!node) {
    throw new NotFoundError();
  }

  return db.flow.findMany({
    where: { ownerNodeId: node.id, deletedAt: null },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
}

/**
 * Pages a Component's Flow palette as lean `FlowPaletteItem`s (Slice 3 / #36).
 * `getCanvas` bundles the first `FLOW_PALETTE_PAGE_SIZE` Flows of each in-scope
 * boundary proxy; when an owner exposes more, the inspector pages the rest in
 * through here. Slug-readable (ADR-0002), same posture as `getFlowsForNode`:
 * possession of the slug grants the read, and the requested Component must live
 * in the slugged Project.
 *
 * Cursor pagination on `(createdAt, id)`: pass the previous page's
 * `nextCursor` (the last Flow's id) to fetch the next page. `nextCursor` is
 * null on the final page. The lean projection matches the bundled palette so
 * the client renders one shape regardless of how a Flow arrived.
 */
export async function getFlowPalette(
  db: Db,
  actor: Actor | null,
  input: GetFlowPaletteInput,
): Promise<{ flows: FlowPaletteItem[]; nextCursor: string | null }> {
  const { ownerNodeId, slug, cursor } = getFlowPaletteInput.parse(input);

  const project = await db.project.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanRead(actor, project, { viaCapabilitySlug: true });

  const node = await db.node.findFirst({
    where: { id: ownerNodeId, projectId: project.id, deletedAt: null },
    select: { id: true },
  });
  if (!node) {
    throw new NotFoundError();
  }

  // A cursor must name a live Flow owned by this Node. Prisma v7 returns an
  // empty page for a cursor that exists but falls outside the `where` filter
  // (rather than throwing), which would turn a foreign or stale Flow id into a
  // silent empty result — and a cross-project existence oracle. Validate it.
  if (cursor) {
    const cursorRow = await db.flow.findFirst({
      where: { id: cursor, ownerNodeId: node.id, deletedAt: null },
      select: { id: true },
    });
    if (!cursorRow) {
      throw new NotFoundError();
    }
  }

  // Fetch one past the page so a full page reveals whether more remain. The
  // `(createdAt, id)` order gives a stable cursor even when several Flows share
  // a createdAt (a re-parse materializes many in one batch).
  const rows = await db.flow.findMany({
    where: { ownerNodeId: node.id, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: FLOW_PALETTE_PAGE_SIZE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      ownerNodeId: true,
      kind: true,
      key: true,
      title: true,
      interaction: true,
    },
  });
  const hasMore = rows.length > FLOW_PALETTE_PAGE_SIZE;
  const flows = hasMore ? rows.slice(0, FLOW_PALETTE_PAGE_SIZE) : rows;
  const nextCursor = hasMore ? (flows[flows.length - 1]?.id ?? null) : null;
  return { flows, nextCursor };
}
