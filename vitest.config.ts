import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolve the `~/*` tsconfig path alias for any test that uses it.
  plugins: [tsconfigPaths()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Sync the test schema once (with a safety guard) before any test runs.
    globalSetup: ["src/test/global-setup.ts"],
    // Load .env.test into each worker before test modules are imported.
    setupFiles: ["src/test/setup-env.ts"],
    // Run test files sequentially so per-test truncation is race-free.
    fileParallelism: false,
    // The service-layer suite hits a real Neon test branch (ADR-0003); each
    // round trip is ~50-150ms. Vitest's 5s default is too tight for tests
    // that exercise multi-step flows like cascading delete + restore. 15s
    // gives headroom for transient cloud-DB latency without masking actual
    // hangs.
    testTimeout: 15_000,
  },
});
