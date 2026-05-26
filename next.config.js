/**
 * Run `build` or `dev` with `SKIP_ENV_VALIDATION` to skip env validation. This is especially useful
 * for Docker builds.
 */
import "./src/env.js";

/** @type {import("next").NextConfig} */
const config = {
  async headers() {
    return [
      {
        // The Project route carries the capability-URL slug — a bearer secret —
        // in its path (ADR-0002). Keep it out of Referer headers sent to any
        // resource the Canvas later embeds, out of search indexes, and out of
        // shared (CDN/proxy) caches. See docs/adr/0004.
        source: "/p/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "private, no-store" },
        ],
      },
    ];
  },
};

export default config;
