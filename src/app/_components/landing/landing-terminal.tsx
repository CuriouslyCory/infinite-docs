"use client";

import { useEffect, useRef, useState } from "react";

import { SectionLabel } from "~/app/_components/landing/section-label";

const LINES = [
  "[ OK ]  INIT infinite-docs",
  "[ OK ]  MOUNT root Canvas",
  "[ OK ]  REGISTER Component graph + Connections",
  "[ OK ]  RESOLVE boundary proxies — read-only, follow you inward",
  "[ OK ]  DESCEND interior Canvas — recurse to any depth",
  "[ OK ]  SERIALIZE graph → deterministic markdown",
  "[ OK ]  MCP server ready — authenticated, agent-ready",
  "ARCHITECTURE IS NOW LEGIBLE TO HUMANS AND AGENTS",
] as const satisfies readonly string[];

const REVEAL_MS = 450;
const INITIAL_VISIBLE = 1;

export function LandingTerminal() {
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    if (reduce) {
      // Defer past the effect body so the reveal-all is a scheduled update, not a
      // synchronous cascading render inside the effect (react-hooks/set-state-in-effect).
      timerRef.current = setTimeout(() => setVisibleCount(LINES.length), 0);
      return () => {
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      };
    }

    const tick = () => {
      setVisibleCount((prev) => {
        const next = prev + 1;
        if (next < LINES.length) {
          timerRef.current = setTimeout(tick, REVEAL_MS);
        }
        return Math.min(next, LINES.length);
      });
    };

    if (INITIAL_VISIBLE < LINES.length) {
      timerRef.current = setTimeout(tick, REVEAL_MS);
    }

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const isComplete = visibleCount >= LINES.length;
  const shown = LINES.slice(0, visibleCount);
  const lastIndex = shown.length - 1;

  return (
    <section className="border-border flex flex-col gap-6 border-b px-6 py-20 sm:px-12 sm:py-28">
      <SectionLabel name="BOOT LOG" index={2} />
      <p className="sr-only">
        A boot-sequence animation: Infinite Docs mounts the root Canvas,
        registers the Component graph and Connections, resolves boundary proxies,
        descends into interior Canvases, serializes the graph to deterministic
        markdown, and starts an authenticated MCP server — making the
        architecture legible to both humans and AI agents.
      </p>
      <div
        className="border-border bg-card border font-mono text-xs sm:text-sm"
        aria-hidden="true"
      >
        <div className="border-border flex items-center gap-2 border-b px-4 py-2">
          <span className="bg-primary h-3 w-3 rounded-full" aria-hidden="true" />
          <span className="text-muted-foreground tracking-widest lowercase">
            ~/infinite-docs — boot
          </span>
        </div>
        <pre className="text-foreground overflow-x-auto px-4 py-4 leading-relaxed whitespace-pre">
          {shown.map((line, i) => {
            const isLast = i === lastIndex;
            const isPayoff = i === LINES.length - 1;
            return (
              <span
                key={i}
                className={`block ${isPayoff ? "text-primary font-bold" : ""}`}
              >
                {line}
                {isLast && !isComplete && (
                  <span
                    className="terminal-caret bg-primary ml-1 inline-block h-[1em] w-[0.6em] translate-y-[0.15em]"
                    aria-hidden="true"
                  />
                )}
              </span>
            );
          })}
          {isComplete && (
            <span className="block">
              {"$ "}
              <span
                className="terminal-caret bg-primary ml-1 inline-block h-[1em] w-[0.6em] translate-y-[0.15em]"
                aria-hidden="true"
              />
            </span>
          )}
        </pre>
      </div>
    </section>
  );
}
