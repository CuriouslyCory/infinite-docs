import Link from "next/link";

/**
 * Shown for an unknown OR soft-deleted slug. The copy is deliberately generic:
 * it must not reveal whether a slug exists-but-forbidden (ADR-0002).
 */
export default function ProjectNotFound() {
  return (
    <main className="flex h-dvh flex-col items-center justify-center gap-4 bg-[#15162c] px-4 text-center text-white">
      <h1 className="text-3xl font-bold">Project not found</h1>
      <p className="max-w-md text-white/60">
        This project doesn’t exist, or the link is no longer valid.
      </p>
      <Link
        href="/"
        className="rounded-full bg-white/10 px-8 py-2 font-semibold no-underline transition hover:bg-white/20"
      >
        Go to your projects
      </Link>
    </main>
  );
}
