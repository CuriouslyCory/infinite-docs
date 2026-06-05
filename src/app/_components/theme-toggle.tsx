"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

/**
 * Light/dark toggle. next-themes leaves `resolvedTheme` undefined on the server and
 * the first client render (it resolves the active theme only after mount), so we
 * render a neutral placeholder in that window — matching markup on both sides avoids
 * a hydration mismatch on the icon without needing a mounted flag. The
 * FOUC-prevention script has already set the correct `.dark` class on <html> before
 * paint, so the page itself never flashes.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="border-border bg-muted text-muted-foreground hover:text-foreground flex h-7 w-7 items-center justify-center rounded-full border transition"
    >
      {resolvedTheme === undefined ? (
        <span className="h-[13px] w-[13px]" />
      ) : isDark ? (
        <Moon size={13} aria-hidden />
      ) : (
        <Sun size={13} aria-hidden />
      )}
    </button>
  );
}
