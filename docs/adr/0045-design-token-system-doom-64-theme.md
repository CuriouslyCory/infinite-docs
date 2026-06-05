# 45. A semantic design-token system (CSS variables + Tailwind v4 `@theme inline`) with a runtime light/dark toggle, rendering the "Doom 64" palette

## Status

Accepted (Doom 64 theme rollout).

**Establishes** the app's first design-token layer. Before this, every color was a
hardcoded inline literal (page `#15162c`, surfaces `#1f2138`/`#1a2433`/`#1a1b2e`/
`#1d1e3a`, a purple accent `hsl(280 100% 70%)`, a `text-white/70..15` ramp) spread
across ~42 component files, with no light mode and no way to re-theme without editing
every file. This ADR centralizes color into semantic tokens so a theme is a one-file
swap, and adds a no-flash light/dark toggle.

## Context

We adopted the **Doom 64** design system from v0 (shadcn-shaped semantic token set:
`background`/`foreground`, `card`, `popover`, `primary`, `secondary`, `accent`,
`muted`, `destructive`, `border`, `input`, `ring`, `chart-1..5`, `sidebar`). The
palette is desaturated gunmetal grays with a **blood-red primary** (hue ~27), a
muted-green secondary, a steel-blue accent, and an **orange destructive** (hue ~46/68),
plus the **Oxanium** display font and a `0.5rem` radius. Light + dark variants, dark
default.

## Decision

1. **Tokens live in `src/styles/globals.css`.** Because the app is **dark by
   default**, the bare `:root` carries the DARK raw oklch values (so the classless
   first paint the server emits is already dark — no light flash), and `:root.light`
   (higher specificity than `:root`, so it wins regardless of source order) overrides
   them with the LIGHT variant. A single `@theme inline` block maps every token into
   Tailwind's `--color-*` namespace so the utilities
   (`bg-background`, `text-foreground`, `border-border`, `bg-primary`,
   `text-muted-foreground`, `bg-card`, `bg-popover`, `bg-destructive`, `ring-ring`,
   …) generate.
   - **`@theme inline` is load-bearing, not `@theme`.** `inline` emits `var(--card)`
     into each utility, so flipping `--card` under `.dark` re-cascades into every
     `bg-card` automatically. A plain `@theme` would bake the literal oklch value into
     the utility and freeze the theme — runtime switching would silently break. (The
     font-family block stays a plain `@theme`; fonts don't switch at runtime.)
   - Opacity modifiers (`bg-card/85`, `text-muted-foreground/70`) work because
     Tailwind v4 wraps any color in `color-mix`. oklch + `color-mix` need Safari
     16.2+/Chrome 111+ — a modern-browser baseline we accept.

2. **Two app-specific tokens beyond the shadcn set: `--edit` and `--portal`.** They
   carry meanings the generic palette can't — `--edit` is the embedded-project
   edit/read-only indicator ([ADR-0042](0042-portal-edit-through-and-portal-interior-guard.md),
   formerly amber); `--portal` marks a Project Portal / embedded boundary (formerly
   sky). Keeping them named (not folded into `destructive`/`accent`) keeps
   `border-portal` self-documenting and lets either move independently of the base
   palette. Both are defined for light and dark.

3. **Light/dark via a tiny in-house mechanism — no `next-themes`.** The app only
   needs class-based light/dark with a dark default and localStorage persistence, so a
   ~40-line bootstrap (`src/lib/theme.ts` + `ThemeToggle`) replaces the dependency and,
   crucially, avoids the dependency's React-19 footgun: next-themes renders its
   no-FOUC `<script>` from a **client** component, and React 19 warns on every
   client-rendered inline `<script>` ("Scripts inside React components are never
   executed when rendering on the client"). Instead:
   - **`themeInitScript`** is a literal string in the plain (non-`"use client"`)
     module `src/lib/theme.ts`, inlined by the **server** root layout as a `<script>`
     at the top of `<body>`. It runs before first paint, reads `localStorage` (default
     dark), and sets the theme class + `color-scheme` on `<html>` — so the first paint
     is already correct (**no FOUC**) and the script is **server-rendered**, never
     client-rendered (no React-19 warning). `<html>` keeps `suppressHydrationWarning`
     for the class the script mutates.
   - **`useTheme`** (in `theme-toggle.tsx`) reads the active theme via
     `useSyncExternalStore` (a `MutationObserver` on the `<html>` class) — the
     sanctioned escape hatch for external state, so there is no setState-in-effect and
     no hydration error when the server snapshot (`"dark"`) differs from the client's
     actual theme. `setTheme` swaps the class + `color-scheme` and writes localStorage.
   - Persistence is per-device localStorage. The per-user-DB upgrade seam (a
     `User.themePreference` column seeding the init script's default) is left unbuilt —
     only the source of the initial value would change, not the class mechanism.

4. **React Flow themed via `--xy-*` variables**, scoped under
   `[data-canvas-scope] .react-flow` in `globals.css` so they win over the
   island-loaded `@xyflow/react/dist/style.css` without editing vendor CSS or moving
   the import out of the canvas island ([ADR-0004](0004-canvas-island-ssr-boundary.md)).
   Edge strokes (`--xy-edge-stroke-*`), the connection line, controls, and the grid
   `<Background color="var(--border)">` all resolve to tokens.

5. **Full retro treatment, kept readable.** A single fixed, `pointer-events:none`
   `.retro-overlay` paints faint scanlines (a low-opacity `repeating-linear-gradient`
   of `--foreground`); `prefers-reduced-motion` dials it down. **`mix-blend-mode` was
   tried and removed** — `overlay` blend over a full app composites unpredictably
   against the canvas's transformed/isolated stacking contexts (it cast the header and
   panels dark in light mode). A plain low-opacity overlay is the safe equivalent.
   Oxanium (`--font-display`) is applied to headings only (`DialogTitle`, the project
   header, `.plate-doc h1/h2/h3`); body and Plate prose stay Geist for readability.
   Key surfaces (nodes, dialogs) use `border-2 border-border` for the chunky Doom panel.

## Consequences

- **The old purple accent becomes Doom red** (`primary`), which now sits in the same
  warm family as the orange `destructive`. They are distinguishable (~20° hue + a
  lightness/chroma gap), but the rule stands: **`destructive` is reserved for
  destructive actions only** — never `bg-primary` on a delete control. Delete affords
  via a `Trash2` icon + `hover:text-destructive`, so icon and position disambiguate.
- **Neither `pnpm check` nor `pnpm test` catches a theming regression** — both are
  color-blind. Every theme change must be verified in-browser **in both modes**, and
  **light mode is the higher-contrast risk** (bright `card`, stacked-opacity text).
- The text ramp collapsed from six white-opacity literals to **two semantic tokens
  plus opacity** (`text-foreground`, `text-muted-foreground[/70]`) — map the role,
  not the old opacity number.
