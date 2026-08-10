import { defineNitroConfig } from "nitro/config";

// Nitro is the build system that compiles the "use workflow" / "use step"
// directives. Hono has no build system of its own; per the WDK getting-started
// guides, Express needs Nitro for the same reason, so this is not a Hono tax.
export default defineNitroConfig({
  modules: ["workflow/nitro"],
  routes: {
    "/**": { handler: "./src/index.ts", format: "node" },
  },
});
