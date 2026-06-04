import type {
  GuestAccess,
  ProjectRole,
} from "../../../generated/prisma/client";
import {
  resolveCapability,
  requireCapability,
  type Capability,
} from "./access";
import type { Actor, Db } from "./actor";
import { NotFoundError } from "./errors";

/**
 * The DB-aware authorization seams (ADR-0040). They live OUT of the pure
 * `access.ts` so that module stays DB-free and bundle-safe; here we do the single
 * membership-aware project load, then hand the already-loaded facts to the pure
 * `resolveCapability`.
 *
 * Two asymmetric seams by necessity:
 *  - READS are slug-keyed and non-disclosing: a denial (`cap < view`) becomes
 *    `NotFoundError`, never `ForbiddenError`, so a `guestAccess=NONE` project is
 *    indistinguishable from a missing one for any non-member — anonymous OR
 *    logged-in (ADR-0002's non-disclosure rule, extended to the whole ladder).
 *  - WRITES are id-keyed and load-then-authorize: a denial surfaces
 *    `ForbiddenError` (the caller already holds the internal handle, so the
 *    denial leaks nothing new).
 *
 * Both funnel through the ONE pure resolver, so the policy is single-sourced.
 * The membership relation is omitted from the select entirely when `actor` is
 * null — an anonymous caller can only ever reach guest capability, so the
 * point-lookup is skipped on the hot capability-URL path (perf philosophy #1).
 */

/** Project facts every read seam returns alongside the resolved capability. */
export interface ReadableProject {
  id: string;
  title: string;
  slug: string;
  ownerId: string;
  guestAccess: GuestAccess;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

/**
 * Slug-keyed read seam: resolve a Project by slug, pull `guestAccess` + the
 * actor's membership (one round trip), and resolve the capability. Throws
 * `NotFoundError` when the slug resolves nothing OR when the resolved capability
 * is below `view` — the non-disclosure mapping lives HERE so every read inherits
 * it (ADR-0040). Returns the full project row + `viewerCapability` so callers
 * that need the row (e.g. `getProjectBySlug`) reuse this single read.
 */
export async function authorizeProjectRead(
  db: Db,
  actor: Actor | null,
  slug: string,
): Promise<{ project: ReadableProject; viewerCapability: Capability }> {
  const project = await db.project.findFirst({
    where: { slug, deletedAt: null },
    select: {
      id: true,
      title: true,
      slug: true,
      ownerId: true,
      guestAccess: true,
      createdAt: true,
      updatedAt: true,
      deletedAt: true,
      ...(actor
        ? {
            memberships: {
              where: { userId: actor.userId },
              select: { role: true },
              take: 1,
            },
          }
        : {}),
    },
  });
  if (!project) {
    throw new NotFoundError();
  }

  const { memberships, ...rest } = project as ReadableProject & {
    memberships?: { role: ProjectRole }[];
  };
  const membership = actor ? (memberships?.[0] ?? null) : null;
  const viewerCapability = resolveCapability(actor, rest, membership);

  // Non-disclosure: a sub-`view` capability is reported as not-found, never
  // forbidden — a `guestAccess=NONE` project looks identical to a missing one.
  if (viewerCapability === "none") {
    throw new NotFoundError();
  }

  return { project: rest, viewerCapability };
}

/**
 * Slug-keyed read seam for callers that only need the project id (the trace
 * reads, the canvas reads). Same non-disclosing mapping as
 * {@link authorizeProjectRead}; returns just `{ id }` so it is a drop-in for the
 * old id-only `findFirst` preamble. The membership query is skipped for anon.
 */
export async function resolveReadableProject(
  db: Db,
  actor: Actor | null,
  slug: string,
): Promise<{ id: string; viewerCapability: Capability }> {
  const project = await db.project.findFirst({
    where: { slug, deletedAt: null },
    select: {
      id: true,
      ownerId: true,
      guestAccess: true,
      ...(actor
        ? {
            memberships: {
              where: { userId: actor.userId },
              select: { role: true },
              take: 1,
            },
          }
        : {}),
    },
  });
  if (!project) {
    throw new NotFoundError();
  }

  const { memberships, ...rest } = project as {
    id: string;
    ownerId: string;
    guestAccess: GuestAccess;
    memberships?: { role: ProjectRole }[];
  };
  const membership = actor ? (memberships?.[0] ?? null) : null;
  const viewerCapability = resolveCapability(actor, rest, membership);
  if (viewerCapability === "none") {
    throw new NotFoundError();
  }
  return { id: rest.id, viewerCapability };
}

/**
 * Id-keyed WRITE seam: load a Project by internal id, resolve the actor's
 * capability (owner identity + membership; guest access still applies but is
 * moot for a write minimum), and `requireCapability(cap, min)` — which throws
 * `ForbiddenError` on deny. A missing / soft-deleted project is `NotFoundError`.
 * Returns the minimal facts every write caller reads downstream (`{ id }`).
 *
 * This replaces the `findFirst({ where:{id,deletedAt:null} }) + assertCanWrite`
 * two-liner at every owner-only write. `min` is `edit` for graph mutations,
 * `owner` only for destroying the Project.
 */
export async function authorizeProjectWrite(
  db: Db,
  actor: Actor,
  projectId: string,
  min: Capability,
): Promise<{ id: string; ownerId: string; guestAccess: GuestAccess }> {
  const project = await db.project.findFirst({
    where: { id: projectId, deletedAt: null },
    select: {
      id: true,
      ownerId: true,
      guestAccess: true,
      memberships: {
        where: { userId: actor.userId },
        select: { role: true },
        take: 1,
      },
    },
  });
  if (!project) {
    throw new NotFoundError();
  }
  const { memberships, ...rest } = project;
  const cap = resolveCapability(actor, rest, memberships[0] ?? null);
  requireCapability(cap, min);
  return rest;
}
