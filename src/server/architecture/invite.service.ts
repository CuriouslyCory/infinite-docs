import { type ProjectRole } from "../../../generated/prisma/client";
import { roleRank } from "./access";
import { authorizeProjectWrite } from "./access-db";
import type { Actor, Db } from "./actor";
import { NotFoundError } from "./errors";
import { isPrismaUniqueViolation } from "./prisma-errors";
import {
  CURRENT_KEY_VERSION,
  generateRawInviteToken,
  hashToken,
  tokenPrefix,
} from "./token-hash";
import {
  claimInviteInput,
  createInviteInput,
  type ClaimInviteInput,
  type CreateInviteInput,
  type ProjectRoleInput,
} from "~/lib/schemas";

const MAX_TOKEN_ATTEMPTS = 3;
const MS_PER_DAY = 86_400_000;

// Compile-time parity guard: the client-safe Zod `projectRole` enum
// (~/lib/schemas) and the Prisma `ProjectRole` enum must describe the same value
// set. If either side drifts, one of these typed maps stops type-checking and
// `pnpm check` fails — the same checked-invariant idiom as `_zodGuestIsPrisma`
// in project.service.ts. The guard lives server-side because importing the
// Prisma enum is the leak we forbid in client code (ADR-0004); the client only
// ever sees the Zod enum.
const _zodRoleIsPrisma: Record<ProjectRoleInput, ProjectRole> = {
  VIEWER: "VIEWER",
  EDITOR: "EDITOR",
  ADMIN: "ADMIN",
};
const _prismaRoleIsZod: Record<ProjectRole, ProjectRoleInput> = {
  VIEWER: "VIEWER",
  EDITOR: "EDITOR",
  ADMIN: "ADMIN",
};
void _zodRoleIsPrisma;
void _prismaRoleIsZod;

function computeExpiresAt(expiresInDays: number | null): Date | null {
  if (expiresInDays === null) return null;
  return new Date(Date.now() + expiresInDays * MS_PER_DAY);
}

export interface MintedInvite {
  /** The raw `infinv_…` token, returned EXACTLY once — never persisted/logged. */
  token: string;
  prefix: string;
  role: ProjectRoleInput;
  expiresAt: Date | null;
}

/**
 * Mints a role-bearing invite link for a Project (#106). Requires `admin` — the
 * owner or an ADMIN member; a VIEWER/EDITOR member or a non-member cannot create
 * invites (ADR-0040). Addressed by `projectId`, so it rides the id-keyed write
 * seam: a deny below `admin` surfaces `ForbiddenError` (the caller already holds
 * the id, so it discloses nothing). The raw token is generated, hashed, and
 * returned exactly once; only its keyed HMAC (`tokenHash`) and non-secret
 * `prefix` persist (ADR-0020). Retries on the astronomically unlikely `tokenHash`
 * collision — the only unique column written, so any P2002 here is that
 * collision (mirrors `createApiToken`).
 */
export async function createInvite(
  db: Db,
  actor: Actor,
  input: CreateInviteInput,
): Promise<MintedInvite> {
  const { projectId, role, expiresInDays, maxUses } =
    createInviteInput.parse(input);
  await authorizeProjectWrite(db, actor, projectId, "admin");
  const expiresAt = computeExpiresAt(expiresInDays);

  for (let attempt = 0; attempt < MAX_TOKEN_ATTEMPTS; attempt++) {
    const raw = generateRawInviteToken();
    try {
      const invite = await db.projectInvite.create({
        data: {
          projectId,
          role,
          tokenHash: hashToken(raw),
          prefix: tokenPrefix(raw),
          keyVersion: CURRENT_KEY_VERSION,
          expiresAt,
          maxUses,
        },
        select: { prefix: true, role: true, expiresAt: true },
      });
      return {
        token: raw,
        prefix: invite.prefix,
        role: invite.role,
        expiresAt: invite.expiresAt,
      };
    } catch (error) {
      if (isPrismaUniqueViolation(error) && attempt < MAX_TOKEN_ATTEMPTS - 1) {
        continue;
      }
      throw error;
    }
  }
  // Unreachable: the loop returns on success or throws on the final attempt.
  throw new Error("Failed to generate a unique invite token.");
}

/**
 * Redeems an invite link into a Membership (#106) — the race-safe, idempotent,
 * non-disclosing claim protocol (ADR-0040 redemption section, validated by the
 * architect review). Runs in ONE interactive transaction at the default READ
 * COMMITTED isolation:
 *
 *  1. Look up the invite by `tokenHash` (the same lookup-by-hash posture as
 *     `resolveActorFromToken`) + the project's owner/slug/`deletedAt` + the
 *     actor's current membership role.
 *  2. NON-DISCLOSURE collapse: missing token, soft-deleted project, revoked,
 *     expired, OR maxed all throw ONE `NotFoundError` — no body, no project
 *     disclosure, indistinguishable (ADR-0002/0040).
 *  3. Owner short-circuit: the owner is the apex identity, never a membership row
 *     (ADR-0040) — return success, no use, no row.
 *  4. Equal-or-higher member short-circuit: a member already at/above the
 *     invite's rank is a no-op success — no use, no write, never a downgrade.
 *  5. Grant (the `@@unique[projectId,userId]` index is the per-user
 *     serialization point): INSERT a new membership, OR conditionally raise a
 *     strictly-lower role to MAX(existing, invite.role) computed in TS. A
 *     concurrent same-user claim that won the insert / already raised the role
 *     makes this a no-op (return without consuming a use) — so use-consumption
 *     is single-valued per user.
 *  6. Consume ONE use ONLY on a real grant, via a raw guarded `UPDATE` whose
 *     `WHERE` re-asserts validity AND compares `useCount < maxUses` (a
 *     column-to-column compare Prisma's `updateMany` cannot express — hence raw
 *     SQL). This guarded increment is the per-invite (maxUses) serialization
 *     primitive: under READ COMMITTED the losing concurrent claim re-reads the
 *     committed row and matches zero rows. `consumed === 0` → the invite was
 *     maxed/revoked/expired between the read and now → throw `NotFoundError`,
 *     which ROLLS BACK the whole txn (including the speculative grant in step 5)
 *     → the same one non-disclosing failure. Grant-before-consume is safe
 *     precisely because of this rollback.
 *
 * Returns `{ slug }` so the route shell `redirect('/p/'+slug)`. The redirect is
 * identical for every success (incl. the owner/equal-or-higher no-ops), which
 * also preserves non-disclosure at the navigation layer.
 */
export async function claimInvite(
  db: Db,
  actor: Actor,
  input: ClaimInviteInput,
): Promise<{ slug: string }> {
  const { token } = claimInviteInput.parse(input);
  const tokenHash = hashToken(token);

  return db.$transaction((tx) => claimWithinTx(tx, actor, tokenHash));
}

async function claimWithinTx(
  tx: Db,
  actor: Actor,
  tokenHash: string,
): Promise<{ slug: string }> {
  const invite = await tx.projectInvite.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      projectId: true,
      role: true,
      revokedAt: true,
      expiresAt: true,
      maxUses: true,
      useCount: true,
      project: {
        select: { slug: true, ownerId: true, deletedAt: true },
      },
    },
  });

  // Non-disclosure collapse: missing / soft-deleted project / revoked / expired
  // / maxed all become ONE indistinguishable NotFoundError.
  const now = Date.now();
  if (!invite) {
    throw new NotFoundError();
  }
  const expired =
    invite.expiresAt !== null && invite.expiresAt.getTime() <= now;
  const maxed = invite.maxUses !== null && invite.useCount >= invite.maxUses;
  if (
    invite.project.deletedAt !== null ||
    invite.revokedAt !== null ||
    expired ||
    maxed
  ) {
    throw new NotFoundError();
  }

  const slug = invite.project.slug;

  // Owner short-circuit: owner is identity, never a membership row — no use, no
  // write (ADR-0040).
  if (actor.userId === invite.project.ownerId) {
    return { slug };
  }

  const existing = await tx.projectMembership.findUnique({
    where: {
      projectId_userId: { projectId: invite.projectId, userId: actor.userId },
    },
    select: { role: true },
  });

  // Equal-or-higher member: no use, no write, never a downgrade. MAX-role is
  // computed in TS over the capability-ladder `roleRank` (access.ts) — never a
  // SQL ordering on the `ProjectRole` enum, whose Postgres text order is NOT its
  // rank order (ADR-0040). MAX is monotone, so a re-claim never downgrades and
  // concurrent claims converge regardless of order.
  if (existing && roleRank(existing.role) >= roleRank(invite.role)) {
    return { slug };
  }

  // Grant — the @@unique[projectId,userId] index serializes concurrent same-user
  // claims. A grant that no-ops (a sibling claim already wrote/raised the row)
  // returns WITHOUT consuming a use, keeping use-consumption single-valued.
  if (!existing) {
    try {
      await tx.projectMembership.create({
        data: {
          projectId: invite.projectId,
          userId: actor.userId,
          role: invite.role,
        },
      });
    } catch (error) {
      if (isPrismaUniqueViolation(error)) {
        // A concurrent same-user claim won the insert → the other claim consumes
        // the use; this one is a no-op success.
        return { slug };
      }
      throw error;
    }
  } else {
    // existing role is strictly lower — raise it to the invite role. The
    // `role: { in: ranksBelow }` predicate makes the raise conditional, so a
    // concurrent claim that already raised it matches zero rows → no use here.
    const ranksBelow = (["VIEWER", "EDITOR", "ADMIN"] as ProjectRole[]).filter(
      (r) => roleRank(r) < roleRank(invite.role),
    );
    const { count } = await tx.projectMembership.updateMany({
      where: {
        projectId: invite.projectId,
        userId: actor.userId,
        role: { in: ranksBelow },
      },
      data: { role: invite.role },
    });
    if (count === 0) {
      return { slug };
    }
  }

  // Consume one use — raw guarded UPDATE. `updateMany` cannot compare two
  // columns (`useCount < maxUses`), so the cap guard is raw SQL. count === 0 ⇒
  // the invite was maxed/revoked/expired between the read and now → roll back
  // (undoing the speculative grant above) via the one NotFoundError.
  const consumed = await tx.$executeRaw`
    UPDATE "ProjectInvite"
    SET "useCount" = "useCount" + 1
    WHERE "id" = ${invite.id}
      AND "revokedAt" IS NULL
      AND ("expiresAt" IS NULL OR "expiresAt" > now())
      AND ("maxUses" IS NULL OR "useCount" < "maxUses")
  `;
  if (consumed === 0) {
    throw new NotFoundError();
  }

  return { slug };
}
