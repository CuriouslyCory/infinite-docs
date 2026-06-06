import { SectionLabel } from "~/app/_components/landing/section-label";

const FEATURES = [
  {
    heading: "INFINITE NESTING",
    body: "Every Component opens into its own Canvas, so you can model at any altitude — from top-level infrastructure down to a single function.",
  },
  {
    heading: "BOUNDARY PROXIES",
    body: "The external systems a Component connects to follow you inward as read-only proxies, so dependency context is never lost on the way down.",
  },
  {
    heading: "DETERMINISTIC MARKDOWN EXPORT",
    body: "The whole graph serializes to stable, diff-friendly markdown for LLM consumption.",
  },
  {
    heading: "MCP SERVER FOR AGENTS",
    body: "An authenticated MCP server lets AI agents read and maintain the architecture as they work on the system it describes.",
  },
] as const satisfies readonly { heading: string; body: string }[];

const FACTS = [
  { label: "NESTING DEPTH", value: "Unbounded" },
  { label: "EXPORT FORMAT", value: "Deterministic Markdown" },
  { label: "AGENT ACCESS", value: "Authenticated MCP" },
] as const satisfies readonly { label: string; value: string }[];

export function LandingFeatures() {
  return (
    <section
      id="features"
      className="border-border flex flex-col gap-10 border-b px-6 py-20 sm:px-12 sm:py-28"
    >
      <SectionLabel name="FEATURES" index={3} />

      <div className="bg-border grid grid-cols-1 gap-px sm:grid-cols-2">
        {FEATURES.map((feature) => (
          <div
            key={feature.heading}
            className="bg-card flex flex-col gap-3 p-6"
          >
            <h3 className="text-foreground flex items-baseline gap-2 font-mono text-sm font-bold tracking-widest uppercase">
              <span className="text-primary" aria-hidden="true">
                {">"}
              </span>
              {feature.heading}
            </h3>
            <p className="text-muted-foreground text-sm leading-relaxed">
              {feature.body}
            </p>
          </div>
        ))}
      </div>

      <dl className="bg-border grid grid-cols-1 gap-px sm:grid-cols-3">
        {FACTS.map((fact) => (
          <div key={fact.label} className="bg-card flex flex-col gap-2 p-6">
            <dt className="text-muted-foreground font-mono text-xs tracking-widest uppercase">
              {fact.label}
            </dt>
            <dd className="text-foreground font-mono text-sm">
              <span className="text-primary">{fact.value}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
