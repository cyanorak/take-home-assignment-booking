import { defineConfig } from "vitest/config";
import { workflow } from "@workflow/vitest";

// The workflow() plugin transforms the directives, builds the workflow/step
// bundles, and runs an in-process Local World per test worker. Workflow data is
// cleared between test files, so tests are isolated without a server.
export default defineConfig({
  plugins: [workflow()],
  test: {
    include: ["tests/**/*.integration.test.ts"],
    testTimeout: 60_000,
  },
});
