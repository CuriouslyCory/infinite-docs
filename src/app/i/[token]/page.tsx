import { TRPCError } from "@trpc/server";
import { redirect } from "next/navigation";

import { InvalidInvite } from "~/app/i/[token]/_components/invalid-invite";
import { auth } from "~/server/auth";
import { api } from "~/trpc/server";

/**
 * The invite-claim route (#106): the raw `infinv_…` invite token as a path
 * segment. A server component — `claimInvite`'s server graph and the Prisma
 * types never reach a client bundle, and `redirect()` is a server primitive.
 *
 * - Anonymous → redirect to sign-in with a `callbackUrl` back to THIS invite, so
 *   the claim completes after signing in (the claim is signed-in only).
 * - Signed-in → claim, then redirect to `/p/[slug]`. Every success (including the
 *   owner / equal-or-higher no-op) redirects identically.
 * - Invalid (`NOT_FOUND`) → render ONE non-disclosing failure view. Any other
 *   error propagates to the error boundary, so a DB outage is not disguised as
 *   "invalid invite".
 *
 * `redirect()` throws a Next control-flow signal, so BOTH redirects sit OUTSIDE
 * the try/catch that swallows `NOT_FOUND` — catching the redirect would break it.
 * Only the `claimInvite` call is inside the try. The raw token is NEVER logged.
 */
export default async function ClaimInvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await auth();

  if (!session?.user) {
    redirect(
      `/api/auth/signin?callbackUrl=${encodeURIComponent(`/i/${token}`)}`,
    );
  }

  let slug: string;
  try {
    ({ slug } = await api.architecture.claimInvite({ token }));
  } catch (error) {
    if (error instanceof TRPCError && error.code === "NOT_FOUND") {
      return <InvalidInvite />;
    }
    throw error;
  }

  redirect(`/p/${slug}`);
}
