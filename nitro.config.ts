import { defineConfig } from "nitro";

// Nitro is the build system that compiles the "use workflow" / "use step"
// directives. Hono has no build system of its own; per the WDK getting-started
// guides, Express needs Nitro for the same reason, so this is not a Hono tax.
//
// No `format: "node"` here — that is the Express shape. Hono's default export
// is a fetch-style app, and passing format:"node" makes Nitro call it as a
// Node handler, which fails at runtime with "handler is not a function".
export default defineConfig({
  modules: ["workflow/nitro"],
  routes: {
    "/**": "./src/index.ts",
  },
});
