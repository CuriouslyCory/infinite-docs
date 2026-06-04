import type {
  GuestAccess,
  ProjectRole,
} from "../../../generated/prisma/client";
import type { Actor } from "./actor";
import { ForbiddenError } from "./errors";

/**
 * A verb-level grant a caller holds on a Project, ranked on a single totally
 * ordered ladder (ADR-0040). Resolved once per request by {@link resolveCapability}
 * and compared `rank >= required` at every gate by {@link requireCapability}.
 * `owner` is the apex (the `ownerId` identity check, never a membership row);
 * `none` is the absence of any grant.
 */
export type Capability = "none" | "view" | "edit" | "admin" | "owner";

// Integer ranks make every gate a single comparison and let admin/owner satisfy
// a lower minimum automatically — a total order, not a partial one (ADR-0040).
const RANK: Record<Capability, number> = {
  none: 0,
  view: 1,
  edit: 2,
  admin: 3,
  owner: 4,
};

// Exhaustive over ProjectRole (like KIND_LABEL over NodeKind): a future role is a
// compile error here until it is mapped onto the ladder. There is no OWNER or
// NONE role — owner is identity, "none" is the absence of a grant.
const ROLE_CAPABILITY: Record<ProjectRole, Capability> = {
  VIEWER: "view",
  EDITOR: "edit",
  ADMIN: "admin",
};

/** The minimal already-loaded project facts the resolver decides over. */
interface ProjectAccessFacts {
  ownerId: string;
  guestAccess: GuestAccess;
}

/**
 * Resolves a caller's effective {@link Capability} over ALREADY-LOADED facts —
 * never re-fetches, so it stays pure, DB-free, and trivially unit-testable (the
 * unit the whole sharing spine rests on, ADR-0040). The DB-aware seams in
 * `access-db.ts` do the load, then call this.
 *
 * The owner is checked FIRST and unconditionally, so the owner is never demoted
 * by a `guestAccess` of `NONE` nor by a stray membership row — ownership is the
 * `project.ownerId` identity, the irrevocable root of trust (ADR-0002/0040).
 * Authorization derives ONLY from `actor.userId` here (and the membership row,
 * itself keyed by userId): `actor.scopes`/`actor.via` are never consulted, so
 * the ladder stays a userId-derived function and token scopes remain
 * stored-not-enforced (ADR-0021).
 */
export function resolveCapability(
  actor: Actor | null,
  project: ProjectAccessFacts,
  membership: { role: ProjectRole } | null,
): Capability {
  if (actor?.userId === project.ownerId) return "owner";
  if (membership) return ROLE_CAPABILITY[membership.role];
  if (project.guestAccess === "VIEW") return "view";
  return "none";
}

/**
 * Asserts a resolved capability meets a minimum, throwing {@link ForbiddenError}
 * when it falls short. This is the WRITE-deny path (a write denial discloses
 * nothing new — the caller already holds the handle). READ seams must NOT surface
 * this Forbidden: a read denial maps to `NotFoundError` at the read seam, so a
 * project you cannot read is indistinguishable from a missing one (the
 * non-disclosure rule, ADR-0002/0040). See `access-db.ts`.
 */
export function requireCapability(cap: Capability, min: Capability): void {
  if (RANK[cap] < RANK[min]) {
    throw new ForbiddenError();
  }
}

/**
 * `true` when the capability meets the minimum — the boolean form route shells
 * use to derive `canEdit`/`canManage` without importing the {@link Capability}
 * type into a client graph. Server-side only (this module reaches the Prisma
 * type graph); the shells compute booleans here and pass plain booleans down.
 */
export function capabilityAtLeast(cap: Capability, min: Capability): boolean {
  return RANK[cap] >= RANK[min];
}

/** The minimal owner-identity shape the owner-only predicates compare against. */
interface OwnedResource {
  ownerId: string;
}

/**
 * The OWNER-ONLY predicates, retained for the surfaces the capability ladder
 * deliberately does NOT touch in this slice (ADR-0040, invariant): the
 * bearer-token MCP read paths (`exportMarkdownForActor`,
 * `getTraceMarkdownForActor`) and API-token management (`token.service`). They
 * treat `guestAccess` as if it were `NONE` and never consult membership — a
 * token actor is authorized exactly as the owner, never via the public guest
 * grant nor (yet) via membership (member parity on MCP is #109). Web/slug reads
 * use the capability ladder instead; these two are the owner-gated exceptions.
 *
 * Owner-only write: throws {@link ForbiddenError} on deny.
 */
export function assertCanWrite(actor: Actor, resource: OwnedResource): void {
  if (actor.userId !== resource.ownerId) {
    throw new ForbiddenError();
  }
}

/**
 * Owner-only read for the bearer-token MCP path: the owner may read; everyone
 * else is denied with {@link ForbiddenError} (the MCP adapter collapses both
 * not-found and forbidden to one non-disclosing "not found", ADR-0002/0022). The
 * `viaCapabilitySlug` escape hatch is retained but unused on these paths — the
 * token path never presents a slug, so it can never reach the guest grant.
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
