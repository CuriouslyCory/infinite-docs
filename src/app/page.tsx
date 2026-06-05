import Link from "next/link";

import { ProjectDashboard } from "~/app/_components/project-dashboard";
import { auth } from "~/server/auth";
import { HydrateClient, api } from "~/trpc/server";

export default async function Home() {
  const session = await auth();

  if (!session?.user) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-card to-background px-4 text-foreground">
        <h1 className="text-5xl font-extrabold tracking-tight sm:text-[5rem]">
          Infinite <span className="text-primary">Docs</span>
        </h1>
        <p className="mt-4 max-w-md text-center text-lg text-muted-foreground">
          Document your software architecture as an infinitely-nestable graph.
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

  void api.architecture.listProjects.prefetch();

  return (
    <HydrateClient>
      <main className="flex min-h-screen flex-col items-center bg-gradient-to-b from-card to-background px-4 py-16 text-foreground">
        <div className="flex w-full max-w-2xl flex-col gap-8">
          <div className="flex items-center justify-between">
            <h1 className="text-3xl font-bold tracking-tight">Your projects</h1>
            <div className="flex items-center gap-4">
              <Link
                href="/connect"
                className="text-sm text-muted-foreground no-underline transition hover:text-foreground"
              >
                Connect an agent
              </Link>
              <Link
                href="/api/auth/signout"
                className="text-sm text-muted-foreground no-underline transition hover:text-foreground"
              >
                Sign out
              </Link>
            </div>
          </div>
          <ProjectDashboard />
        </div>
      </main>
    </HydrateClient>
  );
}
