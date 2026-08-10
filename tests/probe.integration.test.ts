/**
 * TEMPORARY — V1 toolchain probe. Delete with src/probe.ts.
 *
 * Answers the five open WDK questions from PLAN.md §13. Each assertion is
 * written to *record* what WDK does rather than to enforce what we hoped it
 * would do, so a surprise shows up as a readable failure.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { start, getRun } from "workflow/api";
import { getWorld } from "workflow/runtime";
import { app } from "../src/index.js";
import { probeWorkflow, probeState, resetProbeState } from "../src/probe.js";

beforeEach(() => {
  resetProbeState();
});

describe("Q1 — the Vitest plugin runs a workflow in-process", () => {
  it("starts a workflow and resolves its return value", async () => {
    const run = await start(probeWorkflow, ["hello"]);

    expect(run.runId).toMatch(/^wrun_/);

    const result = await run.returnValue;
    expect(result.echoed).toBe("hello");
    expect(await run.status).toBe("completed");
  });
});

describe("Q3 — module singletons across the step boundary", () => {
  it("does NOT share module state between the caller and the step", async () => {
    resetProbeState();
    const before = probeState.stepInvocations;

    const run = await start(probeWorkflow, ["singleton"]);
    const result = await run.returnValue;

    // The step ran and incremented its own copy of the counter...
    expect(result.invocationsSeenByStep).toBeGreaterThan(0);

    // ...but this process never saw the increment. Steps execute in a separate
    // module instance: writes do not cross the boundary in EITHER direction
    // (see also markerVisibleInStep === null in Q2).
    expect(probeState.stepInvocations).toBe(before);

    console.log(
      `[probe] Q3 — step-side counter: ${result.invocationsSeenByStep}, ` +
        `caller-side counter: ${probeState.stepInvocations} (separate instances)`,
    );
  });
});

describe("Q4 — getRun() from outside the starting call", () => {
  it("resolves returnValue via a fresh handle", async () => {
    const run = await start(probeWorkflow, ["rehydrate"]);
    await run.returnValue;

    // The L1 duplicate-join path depends on a *different* request being able
    // to attach to a run it did not start.
    const rehydrated = getRun(run.runId);
    const result = (await rehydrated.returnValue) as { echoed: string };

    expect(result.echoed).toBe("rehydrate");
    expect(await rehydrated.status).toBe("completed");
  });
});

describe("Q5 — world.runs.list() from the test process", () => {
  it("reports started runs, which is how T-conc-1 proves I4", async () => {
    await (await start(probeWorkflow, ["counted"])).returnValue;

    const world = await getWorld();
    const runs = await world.runs.list({ resolveData: "none" });

    expect(Array.isArray(runs.data)).toBe(true);
    expect(runs.data.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Q2 — request-scoped state, and the HTTP layer", () => {
  it("drives the workflow through app.request() without a server", async () => {
    const res = await app.request("/probe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ echo: "over-http" }),
    });

    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      runId: string;
      result: { echoed: string; markerVisibleInStep: string | null };
    };

    expect(body.runId).toMatch(/^wrun_/);
    expect(body.result.echoed).toBe("over-http");

    // A18: we do NOT rely on this being visible. The plan passes everything a
    // step needs as a workflow argument precisely so the answer does not
    // matter. Recorded here so the answer is on the record either way.
    console.log(
      `[probe] A18 — marker visible inside step: ${JSON.stringify(
        body.result.markerVisibleInStep,
      )}`,
    );
  });
});
