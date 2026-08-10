/**
 * V2 — idempotency. M1, M7, invariants I4 and I5.
 *
 * Test isolation: provider and store state accumulate across tests within a
 * file, so every test uses distinct keys and offer ids (CORRECTNESS.md §4.3).
 * Run counts are therefore asserted as *deltas*, never absolutes — an absolute
 * would pass or fail depending on test order, which is exactly the kind of test
 * that proves nothing.
 */
import { describe, it, expect } from "vitest";
import { getWorld } from "workflow/runtime";
import { app } from "../src/index.js";

type BookingBody = {
  bookingId: string;
  state: string;
  requiresIntervention: boolean;
  holdId?: string;
  chargeId?: string;
};

async function post(idempotencyKey: string, body: unknown): Promise<Response> {
  return app.request("/bookings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

const order = (offerId: string, amountCents = 12_500) => ({
  offerId,
  amountCents,
  currency: "GBP",
});

/**
 * Counts booking runs according to the runtime's own registry.
 *
 * Two things learned by inspecting the real API rather than assuming:
 *
 *  - `workflowName` is fully qualified — "workflow//./src/workflows/booking//
 *    bookingWorkflow". The CLI prettifies it; the API does not.
 *  - Run data survives across vitest invocations (it lives in .workflow-data/),
 *    so an absolute count is meaningless. Every assertion here is a delta.
 */
async function runCount(): Promise<number> {
  const world = await getWorld();
  const runs = await world.runs.list({ resolveData: "none" });
  return runs.data.filter((r) => r.workflowName.endsWith("bookingWorkflow")).length;
}

describe("I5 — replay", () => {
  it("returns the identical response for a repeated request", async () => {
    const key = "v2-replay";
    const payload = order("offer-v2-replay");

    const first = await post(key, payload);
    const second = await post(key, payload);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const a = (await first.json()) as BookingBody;
    const b = (await second.json()) as BookingBody;

    // Byte-identical, not merely equivalent: the duplicate returned the
    // winner's cached result rather than deriving its own answer.
    expect(b).toEqual(a);
    expect(b.bookingId).toBe(a.bookingId);
    expect(b.chargeId).toBe(a.chargeId);
  });

  it("does not start a second workflow run for a replay", async () => {
    const key = "v2-replay-runs";
    const payload = order("offer-v2-replay-runs");

    await post(key, payload);
    const afterFirst = await runCount();

    await post(key, payload);
    const afterSecond = await runCount();

    expect(afterSecond).toBe(afterFirst);
  });
});

describe("I5 — fingerprint conflict", () => {
  it("rejects the same key with a different body", async () => {
    const key = "v2-conflict";

    const first = await post(key, order("offer-v2-conflict", 12_500));
    expect(first.status).toBe(201);

    const second = await post(key, order("offer-v2-conflict", 99_900));
    expect(second.status).toBe(409);

    const body = (await second.json()) as { error: { code: string } };
    expect(body.error.code).toBe("idempotency_key_reuse");
  });

  it("charges nothing extra on a conflict", async () => {
    const key = "v2-conflict-no-charge";
    const before = await runCount();

    await post(key, order("offer-v2-cnc", 12_500));
    const afterValid = await runCount();
    expect(afterValid).toBe(before + 1);

    // A conflicting request must not start a workflow — the whole point is
    // that we refuse rather than act.
    await post(key, order("offer-v2-cnc", 500));
    expect(await runCount()).toBe(afterValid);
  });
});

describe("M7 / I4 — idempotency under concurrency", () => {
  it("two simultaneous requests trigger exactly one workflow run", async () => {
    const key = "v2-concurrent";
    const payload = order("offer-v2-concurrent");

    const before = await runCount();

    const [resA, resB] = await Promise.all([post(key, payload), post(key, payload)]);

    // (1) Both callers got the same answer.
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    const a = (await resA.json()) as BookingBody;
    const b = (await resB.json()) as BookingBody;
    expect(b).toEqual(a);

    // (2) The runtime's OWN registry says one run started. This is the
    // assertion that matters: asserting only (1) would pass even if two
    // workflows raced and one lost. Delta, not absolute — runs accumulate
    // across tests in this worker.
    expect(await runCount()).toBe(before + 1);

    // (3) One booking, therefore one hold and one charge (I1, I2).
    expect(a.bookingId).toBe(b.bookingId);
    expect(a.holdId).toBeDefined();
    expect(a.chargeId).toBeDefined();
  });

  it("holds under a wider concurrent burst", async () => {
    const key = "v2-burst";
    const payload = order("offer-v2-burst");

    const before = await runCount();

    const responses = await Promise.all(
      Array.from({ length: 8 }, () => post(key, payload)),
    );
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as BookingBody[];

    expect(await runCount()).toBe(before + 1);

    const bookingIds = new Set(bodies.map((b) => b.bookingId));
    const chargeIds = new Set(bodies.map((b) => b.chargeId));
    expect(bookingIds.size).toBe(1);
    expect(chargeIds.size).toBe(1);
  });
});
