import { LandingFeatures } from "~/app/_components/landing/landing-features";
import { LandingFooter } from "~/app/_components/landing/landing-footer";
import { LandingHero } from "~/app/_components/landing/landing-hero";
import { LandingNav } from "~/app/_components/landing/landing-nav";
import { LandingTerminal } from "~/app/_components/landing/landing-terminal";

export function LandingPage() {
  return (
    <main className="bg-background text-foreground flex min-h-screen flex-col items-center px-4 py-8">
      <div className="border-border bg-card flex w-full max-w-5xl flex-col border">
        <LandingNav />
        <LandingHero />
        <LandingTerminal />
        <LandingFeatures />
        <LandingFooter />
      </div>
    </main>
  );
}
