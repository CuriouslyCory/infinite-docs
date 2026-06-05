"use client";

import { Moon, Sun } from "lucide-react";
import { useCallback, useSyncExternalStore } from "react";

import { THEME_STORAGE_KEY, type Theme } from "~/lib/theme";

// The theme lives on <html> as a class (`light`/`dark`), set before paint by the
// server-rendered init script. We read it through useSyncExternalStore — the
// sanctioned escape hatch for external (non-React) state — so there is no
// setState-in-effect and no hydration error when the server snapshot ("dark", the
// default the server can't see past) differs from the client's actual theme.
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}
function getSnapshot(): Theme {
  return document.documentElement.classList.contains("light")
    ? "light"
    : "dark";
}
function getServerSnapshot(): Theme {
  return "dark";
}

function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setTheme = useCallback((next: Theme) => {
    const el = document.documentElement;
    el.classList.remove("light", "dark");
    el.classList.add(next);
    el.style.colorScheme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // localStorage can throw in private mode; the in-tab class swap still works.
    }
  }, []);
  return { theme, setTheme };
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="border-border bg-muted text-muted-foreground hover:text-foreground flex h-7 w-7 items-center justify-center rounded-full border transition"
    >
      {isDark ? <Moon size={13} aria-hidden /> : <Sun size={13} aria-hidden />}
    </button>
  );
}
