import { Hono } from "hono";
import { start } from "workflow/api";
import { probeState, probeWorkflow } from "./probe.js";

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

/**
 * TEMPORARY — V1 toolchain probe (see src/probe.ts). Replaced by POST /bookings.
 *
 * Mirrors the shape the real handler will have: write some state, start a
 * workflow, await its result, return a typed response. That is enough to prove
 * the Hono layer and the workflow runtime cooperate in-process.
 */
app.post("/probe", async (c) => {
  const { echo } = await c.req.json<{ echo: string }>();

  probeState.requestMarker = `marker-for-${echo}`;

  const run = await start(probeWorkflow, [echo]);
  const result = await run.returnValue;

  return c.json({ runId: run.runId, result });
});

export default app;
