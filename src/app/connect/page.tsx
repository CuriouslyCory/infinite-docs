import Link from "next/link";

import { ConnectAgent } from "~/app/_components/connect-agent";
import { auth } from "~/server/auth";
import { HydrateClient, api } from "~/trpc/server";

export default async function ConnectAgentPage() {
  const session = await auth();

  if (!session?.user) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-card to-background px-4 text-foreground">
        <h1 className="text-3xl font-bold tracking-tight">Connect an agent</h1>
        <p className="mt-4 max-w-md text-center text-muted-foreground">
          Sign in to generate API tokens for connecting an AI agent.
        </p>
        <Link
          href="/api/auth/signin"
          className="mt-8 rounded-full bg-muted px-10 py-3 font-semibold no-underline transition hover:bg-muted"
        >
          Sign in
        </Link>
      </main>
    );
  }

  void api.token.list.prefetch();

  return (
    <HydrateClient>
      <main className="flex min-h-screen flex-col items-center bg-gradient-to-b from-card to-background px-4 py-16 text-foreground">
        <div className="flex w-full max-w-2xl flex-col gap-8">
          <div className="flex items-center justify-between">
            <h1 className="text-3xl font-bold tracking-tight">
              Connect an agent
            </h1>
            <Link
              href="/"
              className="text-sm text-muted-foreground no-underline transition hover:text-foreground"
            >
              Back to projects
            </Link>
          </div>
          <p className="max-w-prose text-muted-foreground">
            Generate an API token to let an AI agent read and work with your
            architecture through the MCP connection. A token acts on your behalf
            — treat it like a password. You’ll see each token only once, right
            after you generate it, so copy it somewhere safe before leaving this
            page.
          </p>
          <ConnectAgent />
        </div>
      </main>
    </HydrateClient>
  );
}
