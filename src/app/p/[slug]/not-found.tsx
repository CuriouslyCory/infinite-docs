import Link from "next/link";

/**
 * Shown for an unknown OR soft-deleted slug. The copy is deliberately generic:
 * it must not reveal whether a slug exists-but-forbidden (ADR-0002).
 */
export default function ProjectNotFound() {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-background px-4 text-center text-foreground">
      <h1 className="text-3xl font-bold">Project not found</h1>
      <p className="max-w-md text-muted-foreground">
        This project doesn’t exist, or the link is no longer valid.
      </p>
      <Link
        href="/"
        className="rounded-full bg-muted px-8 py-2 font-semibold no-underline transition hover:bg-muted"
      >
        Go to your projects
      </Link>
    </main>
  );
}
