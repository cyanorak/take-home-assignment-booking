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
    /**
     * Integration test files must not run in parallel.
     *
     * The plugin gives each worker its own Local World instance, but they share
     * one .workflow-data/ directory on disk. Tests that assert on run-count
     * *deltas* (T-conc-1 proving exactly one workflow ran — M7) then see runs
     * started by another file and fail intermittently.
     *
     * Found by an actual flake, not by reading docs. Serial files cost a few
     * seconds; a flaky concurrency test costs trust in the one assertion the
     * assignment explicitly asks us to make.
     */
    fileParallelism: false,
  },
});
