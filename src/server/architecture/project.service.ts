import {
  type GuestAccess as PrismaGuestAccess,
  type Project,
} from "../../../generated/prisma/client";
import { requireCapability, type Capability } from "./access";
import {
  authorizeProjectRead,
  authorizeProjectWrite,
  resolveWritableProjectBySlug,
} from "./access-db";
import type { Actor, Db } from "./actor";
import { NotFoundError } from "./errors";
import { isSlugCollision } from "./prisma-errors";
import {
  createProjectInput,
  deleteProjectInput,
  getProjectAccessInput,
  getProjectBySlugInput,
  setGuestAccessInput,
  type CreateProjectInput,
  type DeleteProjectInput,
  type GetProjectAccessInput,
  type GuestAccessLevel,
  type GetProjectBySlugInput,
  type ProjectRoleInput,
  type SetGuestAccessInput,
} from "~/lib/schemas";
import { generateSlug } from "./slug";

const MAX_SLUG_ATTEMPTS = 3;

// Compile-time parity guard: the client-safe Zod `guestAccessLevel` enum
// (~/lib/schemas) and the Prisma `GuestAccess` enum must describe the same value
// set. If either side gains or loses a member, one of these typed maps stops
// type-checking and `pnpm check` fails — turning "keep the two enums in sync"
// into a checked invariant (mirrors the `nodeKind` double-Record guard in
// node.service.ts). The guard lives server-side precisely because importing the
// Prisma enum is the leak we forbid in client code (ADR-0004); the client only
// ever sees the Zod enum.
const _zodGuestIsPrisma: Record<GuestAccessLevel, PrismaGuestAccess> = {
  NONE: "NONE",
  VIEW: "VIEW",
};
const _prismaGuestIsZod: Record<PrismaGuestAccess, GuestAccessLevel> = {
  NONE: "NONE",
  VIEW: "VIEW",
};
void _zodGuestIsPrisma;
void _prismaGuestIsZod;

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
 * Lists every (non-deleted) Project the actor can reach as owner OR member —
 * the discovery surface for the bearer-token MCP `resources/list` (#109). Unlike
 * the owner-only {@link listProjects} the web dashboard uses (whose per-card
 * delete is owner-gated), this includes projects where the actor holds a
 * membership row, so a member's owned + shared projects both enumerate. Member-
 * or-owner only: `guestAccess` is NOT consulted — the token path never exposes
 * the public guest grant, so enumeration equals the member-aware read grant
 * (mirrors `exportMarkdownForActor`/`getTraceMarkdownForActor`, ADR-0040 #109).
 *
 * `@@unique([projectId, userId])` on `ProjectMembership` means at most one
 * membership row per actor, so the `some` filter cannot duplicate a project.
 */
export async function listProjectsForActor(
  db: Db,
  actor: Actor,
): Promise<Project[]> {
  return db.project.findMany({
    where: {
      deletedAt: null,
      OR: [
        { ownerId: actor.userId },
        { memberships: { some: { userId: actor.userId } } },
      ],
    },
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
 * owner access, then stamp `deletedAt`. Destroying a Project requires `owner` —
 * a non-owner ADMIN cannot delete (ADR-0040). The slug-keyed write seam keeps a
 * true non-member of a `guestAccess=NONE` project non-disclosed (`NotFoundError`,
 * the slug could be stale) while surfacing `ForbiddenError` to anyone who can
 * read but is below `owner`. The conditional `updateMany` (the `deletedAt: null`
 * predicate) closes the TOCTOU race against a concurrent delete — `count === 0`
 * means another writer won, reported as not-found. A soft-delete leaves child
 * rows intact (no cascade fires); the project simply stops resolving anywhere
 * `deletedAt: null` is filtered. Like `deleteEdge`, this is a *lone* soft-delete
 * — no `deletionId`, no cascade — not the batched, undoable form
 * `deleteTrace`/`deleteNode` use.
 */
export async function deleteProject(
  db: Db,
  actor: Actor,
  input: DeleteProjectInput,
): Promise<{ id: string }> {
  const { slug } = deleteProjectInput.parse(input);
  const project = await resolveWritableProjectBySlug(db, actor, slug, "owner");

  const { count } = await db.project.updateMany({
    where: { id: project.id, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  if (count === 0) {
    throw new NotFoundError();
  }
  return { id: project.id };
}

/**
 * Sets a Project's anonymous-link access level (#105). Requires `admin` — the
 * owner or an ADMIN member; a VIEWER/EDITOR member or a non-member cannot manage
 * sharing (ADR-0040). Addressed by `projectId` (an internal handle the manager
 * already holds), so this rides the id-keyed write seam: a deny below `admin`
 * surfaces `ForbiddenError` (the caller already holds the id, so it discloses
 * nothing). The conditional `updateMany` (`deletedAt: null`) closes the TOCTOU
 * race against a concurrent delete — `count === 0` means another writer won,
 * reported as not-found. Flipping to NONE does not live-evict an already-loaded
 * anonymous reader; #104 enforcement is at read/route time, so their NEXT
 * navigation 404s.
 */
export async function setGuestAccess(
  db: Db,
  actor: Actor,
  input: SetGuestAccessInput,
): Promise<{ id: string; guestAccess: GuestAccessLevel }> {
  const { projectId, level } = setGuestAccessInput.parse(input);
  await authorizeProjectWrite(db, actor, projectId, "admin");

  const { count } = await db.project.updateMany({
    where: { id: projectId, deletedAt: null },
    data: { guestAccess: level },
  });
  if (count === 0) {
    throw new NotFoundError();
  }
  return { id: projectId, guestAccess: level };
}

/** One non-owner member of a Project, as the manage-access panel lists it. */
export interface ProjectAccessMember {
  userId: string;
  name: string | null;
  email: string | null;
  role: ProjectRoleInput;
}

/** One active (non-revoked) invite link, as the manage-access panel lists it. */
export interface ProjectAccessInvite {
  id: string;
  prefix: string;
  role: ProjectRoleInput;
  expiresAt: Date | null;
  maxUses: number | null;
  useCount: number;
}

/**
 * The sharing/access facts the ShareMenu (#105) and the manage-access panel
 * (#108) read. Returned as a NAMED object — never a bare enum — so the #105
 * callers (who read only `.guestAccess`) survive the #108 growth untouched; their
 * optimistic update spreads `{ ...old, guestAccess }`, preserving these fields.
 *
 * `owner` is returned SEPARATELY from `members` because the owner is the apex
 * identity (`ownerId`), never a membership row (ADR-0040) — the panel renders it
 * as a non-editable row. `members` therefore EXCLUDES the owner. `invites` holds
 * only non-revoked links (expired/maxed ones stay visible so an admin sees why a
 * link died and can revoke it; revoked = already dismissed). `viewerUserId` is
 * the admin actor's own id, so the panel can tag "(You)" and confirm self-removal.
 */
export interface ProjectAccess {
  guestAccess: GuestAccessLevel;
  viewerUserId: string;
  owner: { userId: string; name: string | null; email: string | null };
  members: ProjectAccessMember[];
  invites: ProjectAccessInvite[];
}

/**
 * Reads a Project's sharing/access facts (#105, grown for #108), gated on `admin`
 * (ADR-0040). Composes the non-disclosure ladder exactly: `authorizeProjectRead`
 * throws `NotFoundError` when the actor cannot even read (anon/non-member at NONE,
 * or an unknown slug) — a true non-reader stays non-disclosed; then
 * `requireCapability(cap, "admin")` throws `ForbiddenError` for a reader below
 * admin (a guest-VIEW reader, VIEWER, or EDITOR) — they already proved existence
 * by reading, so Forbidden discloses nothing. The owner and ADMIN members get the
 * facts.
 *
 * The three reads fire in one `Promise.all` (no waterfall) and the members read
 * pulls each member's `User.name`/`email` via a relation include (no N+1). The
 * actor is non-null past the admin gate (ADMIN+ requires a session), so
 * `viewerUserId` is `actor.userId`.
 */
export async function getProjectAccess(
  db: Db,
  actor: Actor | null,
  input: GetProjectAccessInput,
): Promise<ProjectAccess> {
  const { slug } = getProjectAccessInput.parse(input);
  const { project, viewerCapability } = await authorizeProjectRead(
    db,
    actor,
    slug,
  );
  requireCapability(viewerCapability, "admin");

  const [owner, members, invites] = await Promise.all([
    db.user.findUnique({
      where: { id: project.ownerId },
      select: { id: true, name: true, email: true },
    }),
    db.projectMembership.findMany({
      where: { projectId: project.id },
      select: {
        userId: true,
        role: true,
        user: { select: { name: true, email: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    db.projectInvite.findMany({
      where: { projectId: project.id, revokedAt: null },
      select: {
        id: true,
        prefix: true,
        role: true,
        expiresAt: true,
        maxUses: true,
        useCount: true,
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return {
    guestAccess: project.guestAccess,
    // Past the admin gate the actor is non-null (ADMIN+ requires a session).
    viewerUserId: actor!.userId,
    owner: {
      userId: project.ownerId,
      name: owner?.name ?? null,
      email: owner?.email ?? null,
    },
    members: members.map((m) => ({
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      role: m.role,
    })),
    invites,
  };
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
