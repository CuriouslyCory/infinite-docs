import { type Project } from "../../../generated/prisma/client";
import { assertCanWrite } from "./access";
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
 * Fetches a Project by its capability-URL slug. Possession of the unguessable
 * slug is the read grant, so `actor` is optional and no access check runs here.
 * A missing or soft-deleted project is reported as not-found (never revealing
 * whether a slug exists-but-forbidden).
 */
export async function getProjectBySlug(
  db: Db,
  _actor: Actor | null,
  input: GetProjectBySlugInput,
): Promise<Project> {
  const { slug } = getProjectBySlugInput.parse(input);
  const project = await db.project.findFirst({
    where: { slug, deletedAt: null },
  });
  if (!project) {
    throw new NotFoundError();
  }
  return project;
}

/**
 * Owner-only soft-delete: resolve the Project by its capability slug, enforce
 * owner access, then stamp `deletedAt`. The conditional `updateMany` (the
 * `deletedAt: null` predicate) closes the TOCTOU race against a concurrent
 * delete — `count === 0` means another writer won, reported as not-found. A
 * soft-delete leaves child rows intact (no cascade fires); the project simply
 * stops resolving anywhere `deletedAt: null` is filtered. Mirrors `deleteTrace`.
 */
export async function deleteProject(
  db: Db,
  actor: Actor,
  input: DeleteProjectInput,
): Promise<{ id: string }> {
  const { slug } = deleteProjectInput.parse(input);
  const project = await db.project.findFirst({
    where: { slug, deletedAt: null },
    select: { id: true, ownerId: true },
  });
  if (!project) {
    throw new NotFoundError();
  }
  assertCanWrite(actor, project);

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
