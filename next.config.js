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
      {
        // The invite-claim route carries the raw invite token — the system's
        // third bearer secret — in its path (#106, ADR-0040). Same hygiene as the
        // slug route: keep the token out of Referer headers, search indexes, and
        // shared caches. The token is single-redemption-intent, capped, and
        // expirable, so a leaked URL has a short, owner-controllable blast radius.
        source: "/i/:path*",
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
