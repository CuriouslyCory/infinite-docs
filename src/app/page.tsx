import Link from "next/link";

import { ProjectDashboard } from "~/app/_components/project-dashboard";
import { auth } from "~/server/auth";
import { HydrateClient, api } from "~/trpc/server";

export default async function Home() {
  const session = await auth();

  if (!session?.user) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-[#2e026d] to-[#15162c] px-4 text-white">
        <h1 className="text-5xl font-extrabold tracking-tight sm:text-[5rem]">
          Infinite <span className="text-[hsl(280,100%,70%)]">Docs</span>
        </h1>
        <p className="mt-4 max-w-md text-center text-lg text-white/70">
          Document your software architecture as an infinitely-nestable graph.
        </p>
        <Link
          href="/api/auth/signin"
          className="mt-8 rounded-full bg-white/10 px-10 py-3 font-semibold no-underline transition hover:bg-white/20"
        >
          Sign in
        </Link>
      </main>
    );
  }

  void api.architecture.listProjects.prefetch();

  return (
    <HydrateClient>
      <main className="flex min-h-screen flex-col items-center bg-gradient-to-b from-[#2e026d] to-[#15162c] px-4 py-16 text-white">
        <div className="flex w-full max-w-2xl flex-col gap-8">
          <div className="flex items-center justify-between">
            <h1 className="text-3xl font-bold tracking-tight">Your projects</h1>
            <Link
              href="/api/auth/signout"
              className="text-sm text-white/60 no-underline transition hover:text-white"
            >
              Sign out
            </Link>
          </div>
          <ProjectDashboard />
        </div>
      </main>
    </HydrateClient>
  );
}
