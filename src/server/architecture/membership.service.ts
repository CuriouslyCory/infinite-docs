import { roleRank } from "./access";
import { authorizeProjectWrite } from "./access-db";
import type { Actor, Db } from "./actor";
import { ConflictError, NotFoundError } from "./errors";
import {
  grantMemberByEmailInput,
  removeMemberInput,
  updateMemberRoleInput,
  type GrantMemberByEmailInput,
  type ProjectRoleInput,
  type RemoveMemberInput,
  type UpdateMemberRoleInput,
} from "~/lib/schemas";

/**
 * The result of {@link grantMemberByEmail} — a typed discriminated union, never a
 * thrown error for the benign no-ops. The UI branches on `status`:
 *  - `granted` carries the RESOLVED role (the MAX of any existing role and the
 *    requested one), so the toast reflects what the member actually holds — a
 *    pre-existing higher role is reported, not the lower role just requested.
 *  - `no_account` is the NON-LEAKY miss: no `User` matched the email. It discloses
 *    NOTHING beyond "no account for that email" — never whether the address exists
 *    in some other project, never any other fact (the non-disclosure rule applied
 *    to identity lookup; ADR-0002/0040). The UI steers to the invite-link path.
 *  - `already_owner` is the owner short-circuit: the owner is the apex identity
 *    (`ownerId`), never a membership row (ADR-0040), so targeting them is a benign
 *    no-op — no row written, no error thrown.
 */
export type GrantMemberResult =
  | { status: "granted"; role: ProjectRoleInput }
  | { status: "no_account" }
  | { status: "already_owner" };

/**
 * Grants a Membership directly by email (#107) — the second grant path alongside
 * the invite link. Requires `admin` (owner or ADMIN member; ADR-0040): a
 * VIEWER/EDITOR member or a non-member is rejected with `ForbiddenError` via the
 * id-keyed write seam (the caller already holds the `projectId`, so a deny
 * discloses nothing).
 *
 * The email is looked up case-insensitively (Discord supplies it on sign-in). A
 * miss returns `{ status: "no_account" }` — the NON-LEAKY result, never an error
 * and never any disclosure beyond "no account for that email". A hit on the owner
 * returns `{ status: "already_owner" }` (owner is identity, never a membership
 * row). Otherwise the membership is upserted at MAX(existing, role): an existing
 * equal-or-higher role is preserved with NO write and reported back, so this can
 * never downgrade a member (mirrors `claimInvite`'s MAX rule, over the same
 * `roleRank` ladder). An admin grant is not a bearer-claim race, so a plain
 * create/update suffices — no use-count or concurrency dance.
 */
export async function grantMemberByEmail(
  db: Db,
  actor: Actor,
  input: GrantMemberByEmailInput,
): Promise<GrantMemberResult> {
  const { projectId, email, role } = grantMemberByEmailInput.parse(input);
  const { ownerId } = await authorizeProjectWrite(
    db,
    actor,
    projectId,
    "admin",
  );

  const user = await db.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true },
  });
  if (!user) {
    return { status: "no_account" };
  }

  if (user.id === ownerId) {
    return { status: "already_owner" };
  }

  const existing = await db.projectMembership.findUnique({
    where: { projectId_userId: { projectId, userId: user.id } },
    select: { role: true },
  });

  if (existing && roleRank(existing.role) >= roleRank(role)) {
    return { status: "granted", role: existing.role };
  }

  if (existing) {
    await db.projectMembership.update({
      where: { projectId_userId: { projectId, userId: user.id } },
      data: { role },
    });
  } else {
    await db.projectMembership.create({
      data: { projectId, userId: user.id, role },
    });
  }

  return { status: "granted", role };
}

/**
 * Changes an existing member's Role (#108). Requires `admin` (owner or ADMIN
 * member; ADR-0040) via the id-keyed write seam — a deny below `admin` surfaces
 * `ForbiddenError` (the caller already holds the `projectId`, so it discloses
 * nothing).
 *
 * DIRECT SET, not MAX. Unlike `grantMemberByEmail`/`claimInvite` (which MAX to
 * never downgrade a bearer claim), an explicit admin action is authoritative: an
 * intentional EDITOR→VIEWER downgrade is the whole point of the panel. The owner
 * is rejected with `ConflictError` BEFORE the write — the owner is the `ownerId`
 * identity, never a membership row, so there is no row to set and the conflict is
 * with that invariant, not a missing row. The conditional `updateMany` (over
 * `update`) makes a concurrently-removed member yield `count === 0` →
 * `NotFoundError` rather than a P2025 throw, closing the TOCTOU race. An admin MAY
 * change another admin's role and MAY change their own; only the owner is
 * untouchable.
 */
export async function updateMemberRole(
  db: Db,
  actor: Actor,
  input: UpdateMemberRoleInput,
): Promise<{ projectId: string; userId: string; role: ProjectRoleInput }> {
  const { projectId, userId, role } = updateMemberRoleInput.parse(input);
  const { ownerId } = await authorizeProjectWrite(
    db,
    actor,
    projectId,
    "admin",
  );

  if (userId === ownerId) {
    throw new ConflictError("Cannot change the owner's role.");
  }

  const { count } = await db.projectMembership.updateMany({
    where: { projectId, userId },
    data: { role },
  });
  if (count === 0) {
    throw new NotFoundError();
  }
  return { projectId, userId, role };
}

/**
 * Removes a member (#108). Requires `admin` (owner or ADMIN member; ADR-0040) via
 * the id-keyed write seam — a deny below `admin` surfaces `ForbiddenError` (the
 * caller already holds the `projectId`).
 *
 * The owner is rejected with `ConflictError` BEFORE the delete (owner is identity,
 * never a membership row — there is no row to delete). The conditional
 * `deleteMany` (over `delete`) makes a concurrent double-remove yield
 * `count === 0` → `NotFoundError` rather than a P2025 throw. An admin MAY remove
 * another admin and MAY remove THEMSELVES (instantly self-demoting to guest/none);
 * the issue forbids only the owner, so `authorizeProjectWrite` does not
 * special-case the actor — do not "fix" that. Deleting the row revokes access on
 * the member's next authorization pass (no live eviction, same as `setGuestAccess`
 * NONE): `resolveCapability` finds no membership and falls back to the guest grant
 * or `none`.
 */
export async function removeMember(
  db: Db,
  actor: Actor,
  input: RemoveMemberInput,
): Promise<{ projectId: string; userId: string }> {
  const { projectId, userId } = removeMemberInput.parse(input);
  const { ownerId } = await authorizeProjectWrite(
    db,
    actor,
    projectId,
    "admin",
  );

  if (userId === ownerId) {
    throw new ConflictError("Cannot remove the owner.");
  }

  const { count } = await db.projectMembership.deleteMany({
    where: { projectId, userId },
  });
  if (count === 0) {
    throw new NotFoundError();
  }
  return { projectId, userId };
}
