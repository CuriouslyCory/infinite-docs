import { type Project } from "../../../generated/prisma/client";
import { type Capability } from "./access";
import { authorizeProjectRead, authorizeProjectWrite } from "./access-db";
import type { Actor, Db } from "./actor";
import { NotFoundError } from "./errors";
import { isSlugCollision } from "./prisma-errors";
import {
  createProjectInput,
  deleteProjectInput,
  getProjectBySlugInput,
  type CreateProjectInput,
  type DeleteProjectInput,
  type GetProjectBySlugInput,
} from "~/lib/schemas";
import { generateSlug } from "./slug";

const MAX_SLUG_ATTEMPTS = 3;

/**
 * Creates a Project owned by the actor. Ownership comes only from the actor —
 * `input` never carries an owner id — so a caller can only ever create a
 * project they own.
 */
export async function createProject(
  db: Db,
  actor: Actor,
  input: CreateProjectInput,
): Promise<Project> {
  const { title } = createProjectInput.parse(input);
  return createWithUniqueSlug(db, actor.userId, title);
}

/** Lists the actor's own (non-deleted) projects, newest first. */
export async function listProjects(db: Db, actor: Actor): Promise<Project[]> {
  return db.project.findMany({
    where: { ownerId: actor.userId, deletedAt: null },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Fetches a Project by its capability-URL slug, gated on `view` (ADR-0040). For a
 * `guestAccess=VIEW` project (the default) any holder of the slug — anonymous or
 * not — resolves `view`, exactly as ADR-0002 specified; a `guestAccess=NONE`
 * project resolves nothing for a non-member and is reported as not-found, never
 * forbidden (the non-disclosure rule lives in the read seam). The owner and any
 * member resolve their own capability.
 *
 * Returns `viewerCapability` alongside the project so the route shells derive
 * `canEdit`/`canManage` without a second authorization pass.
 */
export async function getProjectBySlug(
  db: Db,
  actor: Actor | null,
  input: GetProjectBySlugInput,
): Promise<Project & { viewerCapability: Capability }> {
  const { slug } = getProjectBySlugInput.parse(input);
  const { project, viewerCapability } = await authorizeProjectRead(
    db,
    actor,
    slug,
  );
  return { ...project, viewerCapability };
}

/**
 * Owner-only soft-delete: resolve the Project by its capability slug, enforce
 * owner access, then stamp `deletedAt`. The conditional `updateMany` (the
 * `deletedAt: null` predicate) closes the TOCTOU race against a concurrent
 * delete — `count === 0` means another writer won, reported as not-found. A
 * soft-delete leaves child rows intact (no cascade fires); the project simply
 * stops resolving anywhere `deletedAt: null` is filtered. Like `deleteEdge`,
 * this is a *lone* soft-delete — no `deletionId`, no cascade — not the batched,
 * undoable form `deleteTrace`/`deleteNode` use.
 */
export async function deleteProject(
  db: Db,
  actor: Actor,
  input: DeleteProjectInput,
): Promise<{ id: string }> {
  const { slug } = deleteProjectInput.parse(input);
  const found = await db.project.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true },
  });
  if (!found) {
    throw new NotFoundError();
  }
  // Destroying a Project requires `owner` — a non-owner ADMIN cannot delete
  // (ADR-0040). Authorized by internal id; ownership comes from the actor.
  const project = await authorizeProjectWrite(db, actor, found.id, "owner");

  const { count } = await db.project.updateMany({
    where: { id: project.id, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (count === 0) {
    throw new NotFoundError();
  }
  return { id: project.id };
}

async function createWithUniqueSlug(
  db: Db,
  ownerId: string,
  title: string,
): Promise<Project> {
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    try {
      return await db.project.create({
        data: { title, ownerId, slug: generateSlug() },
      });
    } catch (error) {
      if (isSlugCollision(error) && attempt < MAX_SLUG_ATTEMPTS - 1) {
        continue;
      }
      throw error;
    }
  }
  // Unreachable: the loop returns on success or throws on the final attempt.
  throw new Error("Failed to generate a unique project slug.");
}
