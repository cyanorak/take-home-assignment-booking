import { defineConfig } from "vitest/config";

// Unit tests only: no workflow plugin, so "use step" / "use workflow" are
// no-ops and step functions run as plain async functions. Fast, no runtime.
// Integration tests live in vitest.integration.config.ts.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: ["tests/**/*.integration.test.ts"],
  },
});
