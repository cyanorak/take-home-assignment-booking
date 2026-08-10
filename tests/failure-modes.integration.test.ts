/**
 * V3 — failure modes through the running workflow. M5, and I1/I2 under retry.
 *
 * Provider state is not readable from this process (steps run in a separate
 * module instance), so these tests assert through the runtime's own step log:
 * how many attempts ran, and what idempotency key the persisted input carries.
 * Combined with the provider idempotency proved directly in
 * tests/chaos.test.ts, that is what establishes "exactly one charge".
 */
import { describe, it, expect } from "vitest";
import { getWorld } from "workflow/runtime";
import { hydrateResourceIO, observabilityRevivers } from "workflow/observability";
import { app } from "../src/index.js";

type BookingBody = {
  bookingId: string;
  state: string;
  holdId?: string;
  chargeId?: string;
};

async function post(key: string, offerId: string, chaos?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "Idempotency-Key": key,
  };
  if (chaos) headers["X-Chaos"] = chaos;

  return app.request("/bookings", {
    method: "POST",
    headers,
    body: JSON.stringify({ offerId, amountCents: 12_500, currency: "GBP" }),
  });
}

/** The runId for the most recent booking run, via the runtime's registry. */
async function latestRunId(): Promise<string> {
  const world = await getWorld();
  const runs = await world.runs.list({ resolveData: "none" });
  const booking = runs.data
    .filter((r) => r.workflowName.endsWith("bookingWorkflow"))
    .sort((a, b) => ((a.startedAt ?? "") < (b.startedAt ?? "") ? 1 : -1));
  return booking[0]!.runId;
}

/**
 * One step record, with `attempt` counting how many times it ran.
 *
 * Learned by inspection: world.steps.list() returns ONE row per step, not one
 * per attempt. `attempt: 3` means it ran three times. The step's `input` is
 * persisted once and replayed on every retry — which is a stronger guarantee
 * than checking that each attempt used the same idempotency key, because the
 * key is structurally incapable of varying between attempts.
 *
 * Hydrated `input` is `{ args: [...] }`, not a bare array, and `resolveData:
 * "all"` is required or input/output come back undefined. Both learned by
 * inspection — neither is in the docs we could reach.
 */
async function stepRecord(runId: string, stepName: string) {
  const world = await getWorld();
  // resolveData: "all" is required — input/output are not loaded by default.
  const steps = await world.steps.list({ runId, resolveData: "all" });
  const match = steps.data.find((s) => s.stepName.includes(stepName));
  if (!match) throw new Error(`no step recorded matching ${stepName}`);
  return hydrateResourceIO(match, observabilityRevivers);
}

describe("transient failures recover", () => {
  it("retries a 5xx charge and still confirms", async () => {
    const res = await post("v3-5xx", "offer-v3-5xx", "charge=http_5xx,ok");

    expect(res.status).toBe(201);
    const body = (await res.json()) as BookingBody;
    expect(body.state).toBe("confirmed");
    expect(body.chargeId).toBeDefined();
  });

  it("retries a timed-out hold and still confirms", async () => {
    const res = await post("v3-timeout", "offer-v3-timeout", "hold=timeout,ok");

    expect(res.status).toBe(201);
    const body = (await res.json()) as BookingBody;
    expect(body.state).toBe("confirmed");
    expect(body.holdId).toBeDefined();
  });
});

describe("I1 — applied_then_lost on charge", () => {
  it("retries and recovers, charging once", async () => {
    // The provider commits the charge and then loses the response. The caller
    // cannot tell this from "never happened" — only the idempotency key can.
    const res = await post("v3-lost-charge", "offer-v3-lost-charge", "charge=applied_then_lost");

    expect(res.status).toBe(201);
    const body = (await res.json()) as BookingBody;
    expect(body.state).toBe("confirmed");

    const step = await stepRecord(await latestRunId(), "chargeStep");

    // It genuinely retried — otherwise this test proves nothing.
    expect(step.attempt).toBe(2);

    // The persisted input carries the idempotency key, derived from the
    // booking rather than the execution. That key plus a provider idempotent
    // on keys (proved directly in tests/chaos.test.ts) is what makes this one
    // charge rather than two — I1.
    const { args } = step.input as { args: unknown[] };
    const key = args[2] as string;
    expect(key).toMatch(/^bkg:bkg_.*:charge$/);

    // The recorded output is the charge the provider returned — and its own
    // idempotencyKey matches, so the retry read-repaired rather than recharged.
    const charge = step.output as { idempotencyKey: string; status: string };
    expect(charge.idempotencyKey).toBe(key);
    expect(charge.status).toBe("succeeded");
  });
});

describe("I2 — applied_then_lost on hold", () => {
  it("retries and recovers, holding once", async () => {
    const res = await post("v3-lost-hold", "offer-v3-lost-hold", "hold=applied_then_lost");

    expect(res.status).toBe(201);
    const body = (await res.json()) as BookingBody;
    expect(body.state).toBe("confirmed");

    const step = await stepRecord(await latestRunId(), "holdStep");
    expect(step.attempt).toBe(2);

    const { args } = step.input as { args: unknown[] };
    const key = args[1] as string;
    expect(key).toMatch(/^bkg:bkg_.*:hold$/);
  });
});

describe("retry classification", () => {
  it("does NOT retry a permanent failure", async () => {
    // A declined card is not a transient fault. Retrying it is noise against a
    // finite budget, so the step throws FatalError and WDK stops immediately.
    await post("v3-permanent", "offer-v3-permanent", "charge=permanent");

    const step = await stepRecord(await latestRunId(), "chargeStep");
    expect(step.attempt).toBe(1);
  });

  it("DOES retry a transient failure", async () => {
    // The mirror of the test above: same shape, opposite classification. Both
    // are needed — either alone would pass with the classification inverted.
    await post("v3-transient", "offer-v3-transient", "charge=http_5xx,http_5xx,ok");

    const step = await stepRecord(await latestRunId(), "chargeStep");
    expect(step.attempt).toBe(3); // two 5xx, then success
  });
});
