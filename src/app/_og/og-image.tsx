import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { ImageResponse } from "next/og";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_ALT =
  "Infinite Docs — Document your architecture as an infinite graph";
export const OG_CONTENT_TYPE = "image/png";

const COLORS = {
  background: "#2b2b2b",
  card: "#3a3a3a",
  border: "#575757",
  foreground: "#e3e3e3",
  muted: "#a9a9a9",
  accent: "#e0432b",
};

function OgArt() {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        backgroundColor: COLORS.background,
        color: COLORS.foreground,
        fontFamily: "IBM Plex Mono",
        padding: 48,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          flex: 1,
          border: `4px solid ${COLORS.border}`,
          borderRadius: 0,
          backgroundColor: COLORS.card,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            borderBottom: `4px solid ${COLORS.border}`,
            padding: "16px 24px",
            fontSize: 26,
            color: COLORS.muted,
          }}
        >
          <div
            style={{
              width: 18,
              height: 18,
              backgroundColor: COLORS.accent,
              marginRight: 16,
            }}
          />
          <span>~/infinite-docs — boot</span>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            justifyContent: "center",
            padding: "0 56px",
          }}
        >
          <div
            style={{
              display: "flex",
              fontSize: 44,
              fontWeight: 700,
              letterSpacing: 2,
            }}
          >
            <span>INFINITE</span>
            <span style={{ color: COLORS.accent }}>_</span>
            <span>DOCS</span>
          </div>

          <div
            style={{
              display: "flex",
              marginTop: 28,
              fontSize: 76,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: -1,
              maxWidth: 980,
            }}
          >
            DOCUMENT YOUR ARCHITECTURE AS AN INFINITE GRAPH
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              marginTop: 40,
              fontSize: 28,
              color: COLORS.muted,
            }}
          >
            <span style={{ color: COLORS.accent, marginRight: 14 }}>[ OK ]</span>
            <span>graph serialized → deterministic markdown</span>
            <span style={{ marginLeft: 12, color: COLORS.accent }}>▋</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export async function renderOgImage() {
  const [monoRegular, monoBold] = await Promise.all([
    readFile(join(process.cwd(), "assets/fonts/IBMPlexMono-Regular.ttf")),
    readFile(join(process.cwd(), "assets/fonts/IBMPlexMono-Bold.ttf")),
  ]);

  return new ImageResponse(<OgArt />, {
    ...OG_SIZE,
    fonts: [
      {
        name: "IBM Plex Mono",
        data: monoRegular,
        weight: 400,
        style: "normal",
      },
      { name: "IBM Plex Mono", data: monoBold, weight: 700, style: "normal" },
    ],
  });
}
