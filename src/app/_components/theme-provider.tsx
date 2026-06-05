"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import { type ComponentProps } from "react";

/**
 * Client shim around next-themes so the server root layout never imports a client
 * library directly. next-themes injects a pre-paint inline script that sets the
 * theme class on <html> before React hydrates — paired with `suppressHydrationWarning`
 * on <html> in the layout, this is what prevents a flash of the wrong theme (FOUC).
 */
export function ThemeProvider(
  props: ComponentProps<typeof NextThemesProvider>,
) {
  return <NextThemesProvider {...props} />;
}
