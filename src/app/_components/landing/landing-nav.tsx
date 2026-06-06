import Link from "next/link";

import { ThemeToggle } from "~/app/_components/theme-toggle";

export function LandingNav() {
  return (
    <nav className="border-border flex items-center justify-between border-b px-6 py-4">
      <span className="text-foreground font-mono text-sm font-bold tracking-widest uppercase">
        INFINITE_DOCS
      </span>
      <div className="flex items-center gap-4">
        <ThemeToggle />
        <Link
          href="/api/auth/signin"
          className="text-muted-foreground hover:text-foreground font-mono text-xs tracking-widest uppercase no-underline transition"
        >
          SIGN IN
        </Link>
      </div>
    </nav>
  );
}
