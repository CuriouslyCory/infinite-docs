import { roleRank } from "./access";
import { authorizeProjectWrite } from "./access-db";
import type { Actor, Db } from "./actor";
import {
  grantMemberByEmailInput,
  type GrantMemberByEmailInput,
  type ProjectRoleInput,
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
