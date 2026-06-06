import "~/styles/globals.css";

import { type Metadata } from "next";
import { Geist, IBM_Plex_Mono, Oxanium } from "next/font/google";

import { themeInitScript } from "~/lib/theme";
import { TRPCReactProvider } from "~/trpc/react";

export const metadata: Metadata = {
  title: "Infinite Docs — Document your architecture as an infinite graph",
  description:
    "A drag-and-drop tool for documenting software architecture as an infinitely-nestable graph. Place Components on a Canvas, descend into any Component's interior, and serialize the whole graph to deterministic markdown — with an authenticated MCP server for AI agents.",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
  openGraph: {
    title: "Infinite Docs — Document your architecture as an infinite graph",
    description:
      "Document software architecture as an infinitely-nestable graph of Components and Connections. Descend into any Component, serialize to deterministic markdown, and let AI agents read and maintain it over an authenticated MCP server.",
    type: "website",
    siteName: "Infinite Docs",
  },
  twitter: {
    card: "summary_large_image",
    title: "Infinite Docs — Document your architecture as an infinite graph",
    description:
      "Document software architecture as an infinitely-nestable graph. Descend into any Component, serialize to deterministic markdown, and maintain it via an authenticated MCP server for AI agents.",
  },
};

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist-sans",
});

const oxanium = Oxanium({
  subsets: ["latin"],
  variable: "--font-oxanium",
});

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ibm-plex-mono",
});

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geist.variable} ${oxanium.variable} ${ibmPlexMono.variable}`}
      suppressHydrationWarning
    >
      <body className="bg-background text-foreground font-sans antialiased">
        {/* Applies the stored/default theme class before first paint (no FOUC).
            Server-rendered, so React never client-renders a <script> (which it
            warns about). suppressHydrationWarning on <html> covers the class it
            mutates. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        <TRPCReactProvider>{children}</TRPCReactProvider>
        <div className="retro-overlay" aria-hidden />
      </body>
    </html>
  );
}
