/**
 * Theme bootstrap shared by the server layout (which inlines {@link themeInitScript})
 * and the client {@link useTheme} hook. Kept in a plain module — NOT a `"use client"`
 * file — so the server root layout can import the literal script string (a `"use
 * client"` export would arrive as a client reference, not the string).
 *
 * The app is dark by default; light is opt-in and persisted per-device in
 * `localStorage`. The token layer keys off the theme CLASS on <html> (`:root` is the
 * dark default, `:root.light` overrides — see globals.css / ADR-0045).
 */
export const THEME_STORAGE_KEY = "theme";

export type Theme = "light" | "dark";

/**
 * Runs synchronously, before first paint, from a server-rendered <script> at the top
 * of <body>. Reads the stored theme (default dark) and applies the class + color-scheme
 * to <html> so the very first paint is already the correct theme — no flash, and no
 * client-rendered script (which React 19 warns about). Server-rendered, so it never
 * re-runs on the client.
 */
export const themeInitScript = `(function(){try{var d=document.documentElement,t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)})||"dark",m=t==="light"?"light":"dark";d.classList.remove("light","dark");d.classList.add(m);d.style.colorScheme=m;}catch(e){document.documentElement.classList.add("dark");}})();`;
