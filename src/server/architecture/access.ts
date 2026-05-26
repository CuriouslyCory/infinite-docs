import type { Actor } from "./actor";
import { ForbiddenError } from "./errors";

/**
 * The minimal shape needed to authorize against a resource. Access predicates
 * operate over already-loaded data — they never re-fetch — so they stay pure,
 * DB-free, and trivially unit-testable.
 */
interface OwnedResource {
  ownerId: string;
}

/** Write capability: owner only. Throws {@link ForbiddenError} on deny. */
export function assertCanWrite(actor: Actor, resource: OwnedResource): void {
  if (actor.userId !== resource.ownerId) {
    throw new ForbiddenError();
  }
}

/**
 * Read capability: the owner may always read; a non-owner may read only when a
 * valid capability context was presented (e.g. a capability-URL slug, resolved
 * by the adapter). Throws {@link ForbiddenError} on deny.
 *
 * Note: the M0 slug path (`getProjectBySlug`) does NOT call this — possession of
 * the unguessable slug IS the read grant. This predicate is for owner-scoped
 * reads of resources fetched by internal id.
 */
export function assertCanRead(
  actor: Actor | null,
  resource: OwnedResource,
  opts?: { viaCapabilitySlug?: boolean },
): void {
  if (opts?.viaCapabilitySlug) return;
  if (actor?.userId === resource.ownerId) return;
  throw new ForbiddenError();
}
