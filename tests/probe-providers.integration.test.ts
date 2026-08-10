/**
 * TEMPORARY — V1 provider-boundary probe. Delete with the other probes.
 *
 * Does mock-provider state backed by a module-level Map actually work across
 * four distinct step routes? If not, the mock providers need a shared backing
 * and PLAN.md §11 changes again. Assumes nothing; see src/probe-providers.ts.
 */
import { describe, it, expect } from "vitest";
import { start } from "workflow/api";
import {
  providerProbeWorkflow,
  type ProviderProbeResult,
} from "../src/probe-providers.js";

async function runProbe(runKey: string): Promise<ProviderProbeResult> {
  const run = await start(providerProbeWorkflow, [runKey]);
  return (await run.returnValue) as ProviderProbeResult;
}

describe("provider state across step routes", () => {
  it("P1 — holdStep creates a hold", async () => {
    const r = await runProbe("p1");

    expect(r.created.hold.holdId).toMatch(/^hold_/);
    expect(r.created.hold.status).toBe("held");
    expect(r.created.reusedExisting).toBe(false);
  });

  it("P2 — consumeStep reads and consumes the exact hold holdStep created", async () => {
    const r = await runProbe("p2");

    // The assertion that matters: a DIFFERENT step route found the hold.
    expect(r.consumed.found).toBe(true);
    expect(r.consumed.statusSeen).toBe("consumed");
  });

  it("P3 — releaseStep reads a hold created by holdStep", async () => {
    const r = await runProbe("p3");

    expect(r.released.found).toBe(true);
    expect(r.released.statusSeen).toBe("released");
  });

  it("P4 — a retried step sees the provider's prior idempotency record", async () => {
    const r = await runProbe("p4");

    // The step committed a charge and then threw. WDK retried it, and the
    // retry found the committed record via the same key instead of charging
    // again. This is I1 — the exercise's central case.
    expect(r.recoveredCharge.attempt).toBeGreaterThan(0);
    expect(r.recoveredCharge.reusedExisting).toBe(true);
    expect(r.recoveredCharge.charge.amountCents).toBe(2500);
  });

  it("P5 — charge state survives between separate charge-step invocations", async () => {
    const r = await runProbe("p5");

    expect(r.firstCharge.reusedExisting).toBe(false);
    expect(r.secondCharge.reusedExisting).toBe(true);
    expect(r.secondCharge.charge.chargeId).toBe(r.firstCharge.charge.chargeId);
  });

  it("reports whether the step routes share one module instance", async () => {
    const r = await runProbe("instances");

    const instances = new Set([
      r.created.instanceId,
      r.consumed.instanceId,
      r.released.instanceId,
      r.firstCharge.instanceId,
      r.recoveredCharge.instanceId,
    ]);

    console.log(
      `[probe] distinct step module instances: ${instances.size} ` +
        `(${[...instances].join(", ")})`,
    );
    console.log(
      `[probe] store sizes as seen by last charge step: ` +
        `holds=${r.recoveredCharge.holdsInStore} charges=${r.recoveredCharge.chargesInStore}`,
    );

    // Recorded, not enforced: P1-P5 are the behavioural contract. If they pass
    // with several instances, sharing is happening some other way and the
    // conclusion still holds.
    expect(instances.size).toBeGreaterThanOrEqual(1);
  });
});
