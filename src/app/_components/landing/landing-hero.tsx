import Link from "next/link";

import { SectionLabel } from "~/app/_components/landing/section-label";

export function LandingHero() {
  return (
    <section className="dot-grid border-border flex flex-col gap-8 border-b px-6 py-20 sm:px-12 sm:py-28">
      <SectionLabel name="HERO" index={1} />
      <h1 className="text-foreground font-mono text-4xl font-bold tracking-tight uppercase sm:text-6xl">
        DOCUMENT YOUR
        <br />
        <span className="text-primary">ARCHITECTURE</span>
        <br />
        AS AN INFINITE GRAPH
      </h1>
      <p className="text-muted-foreground max-w-2xl text-base sm:text-lg">
        Place Components on a Canvas, link them with Connections, and open any
        Component to descend into its own interior Canvas — recursing from
        top-level infrastructure down to a single function. The whole graph
        serializes to deterministic markdown, and an authenticated MCP server
        lets AI agents read and maintain it alongside you.
      </p>
      <div className="flex flex-wrap items-center gap-4">
        <Link
          href="/api/auth/signin"
          className="bg-primary text-primary-foreground border-border rounded-none border px-8 py-3 font-mono text-xs font-bold tracking-widest uppercase no-underline transition hover:opacity-90"
        >
          SIGN IN
        </Link>
        <a
          href="#features"
          className="border-border bg-card text-foreground rounded-none border px-8 py-3 font-mono text-xs font-bold tracking-widest uppercase no-underline transition hover:opacity-90"
        >
          SEE HOW IT WORKS
        </a>
      </div>
    </section>
  );
}
