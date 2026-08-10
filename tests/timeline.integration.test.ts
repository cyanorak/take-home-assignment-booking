/**
 * V5 — the audit timeline. M8.
 *
 * The test the assignment implies: "would this help someone investigate three
 * weeks later?" So these assert on what an investigator actually needs — what
 * was sent, what came back, which key was used, every retry with its reason,
 * and why it ended the way it did — rather than on the shape of the JSON.
 */
import { describe, it, expect } from "vitest";
import { app } from "../src/index.js";

type TimelineEvent = {
  at: string;
  type: string;
  step?: string;
  idempotencyKey?: string;
  durationMs?: number;
  detail?: Record<string, unknown>;
};

type Timeline = {
  booking: Record<string, unknown>;
  runId?: string;
  events: TimelineEvent[];
};

async function book(key: string, offerId: string, chaos?: string): Promise<string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "Idempotency-Key": key,
  };
  if (chaos) headers["X-Chaos"] = chaos;

  const res = await app.request("/bookings", {
    method: "POST",
    headers,
    body: JSON.stringify({ offerId, amountCents: 12_500, currency: "GBP" }),
  });
  return ((await res.json()) as { bookingId: string }).bookingId;
}

async function timeline(bookingId: string): Promise<Timeline> {
  const res = await app.request(`/bookings/${bookingId}/timeline`);
  expect(res.status).toBe(200);
  return (await res.json()) as Timeline;
}

const typesOf = (t: Timeline) => t.events.map((e) => e.type);

describe("timeline of a successful booking", () => {
  it("tells the whole story in order", async () => {
    const id = await book("v5-happy", "offer-v5-happy");
    const t = await timeline(id);

    expect(t.booking["state"]).toBe("confirmed");
    expect(t.runId).toMatch(/^wrun_/);

    expect(typesOf(t)).toEqual([
      "booking.created",
      "workflow.started",
      "step.started", // hold
      "step.succeeded",
      "step.started", // charge
      "step.succeeded",
      "step.started", // consume
      "step.succeeded",
      "booking.settled",
    ]);

    // Chronological.
    const times = t.events.map((e) => new Date(e.at).getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("records which idempotency key each provider call used", async () => {
    const id = await book("v5-keys", "offer-v5-keys");
    const t = await timeline(id);

    const charge = t.events.find((e) => e.step === "chargeStep" && e.type === "step.started");
    const hold = t.events.find((e) => e.step === "holdStep" && e.type === "step.started");

    // The single most important thing an investigator can check: the key was
    // derived from the booking, not from the execution.
    expect(hold?.idempotencyKey).toBe(`bkg:${id}:hold`);
    expect(charge?.idempotencyKey).toBe(`bkg:${id}:charge`);
  });

  it("records what was sent and what came back", async () => {
    const id = await book("v5-io", "offer-v5-io");
    const t = await timeline(id);

    const started = t.events.find((e) => e.step === "chargeStep" && e.type === "step.started");
    expect(started?.detail?.["args"]).toEqual([12_500, "GBP", `bkg:${id}:charge`]);

    const done = t.events.find((e) => e.step === "chargeStep" && e.type === "step.succeeded");
    const result = done?.detail?.["result"] as { chargeId: string; status: string };
    expect(result.chargeId).toMatch(/^ch_/);
    expect(result.status).toBe("succeeded");
    expect(done?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("omits the mock-only chaos script from the recorded arguments", async () => {
    const id = await book("v5-noscript", "offer-v5-noscript", "charge=ok");
    const t = await timeline(id);

    for (const event of t.events) {
      const args = event.detail?.["args"];
      if (Array.isArray(args)) {
        expect(args.every((a) => typeof a !== "object")).toBe(true);
      }
    }
  });
});

describe("timeline of a booking that retried", () => {
  it("shows each retry with its reason and backoff", async () => {
    const id = await book("v5-retry", "offer-v5-retry", "charge=http_5xx,http_5xx,ok");
    const t = await timeline(id);

    const retries = t.events.filter((e) => e.type === "step.retrying");
    expect(retries).toHaveLength(2);

    for (const retry of retries) {
      expect(retry.step).toBe("chargeStep");
      expect(retry.detail?.["reason"]).toMatch(/payment 503/);
      // The backoff actually applied — otherwise "it retried" is unexplained.
      expect(retry.detail?.["retryAfter"]).toBeDefined();
    }

    // And it still succeeded, so the story ends well.
    expect(t.booking["state"]).toBe("confirmed");
  });

  it("shows the backoff ESCALATING between attempts", async () => {
    const id = await book("v5-backoff", "offer-v5-backoff", "charge=http_5xx,http_5xx,ok");
    const t = await timeline(id);

    const retries = t.events.filter((e) => e.type === "step.retrying");
    expect(retries).toHaveLength(2);

    // Each retry records when it will next run. The gap from the retry event
    // to that time is the backoff actually applied.
    const backoffs = retries.map(
      (r) => new Date(r.detail!["retryAfter"] as string).getTime() - new Date(r.at).getTime(),
    );

    // A version of classify() took `attempt` as a step parameter the workflow
    // could not supply, so it was always 1 and every backoff was identical.
    // The escalation existed only in the comment. This is the assertion that
    // would have caught it.
    expect(backoffs[1]!).toBeGreaterThan(backoffs[0]!);
  });

  it("does not leak stack traces into the audit trail", async () => {
    const id = await book("v5-nostack", "offer-v5-nostack", "charge=http_5xx,ok");
    const t = await timeline(id);

    const serialised = JSON.stringify(t);
    expect(serialised).not.toContain("node_modules");
    expect(serialised).not.toContain("    at ");
  });
});

describe("timeline of the quadrant that costs a human", () => {
  it("explains charged_not_booked well enough to act on", async () => {
    const id = await book("v5-cnb", "offer-v5-cnb", "consume=permanent");
    const t = await timeline(id);

    // 1. What state is it in, and does someone need to act?
    expect(t.booking["state"]).toBe("charged_not_booked");
    expect(t.booking["requiresIntervention"]).toBe(true);

    // 2. What do they need in order to act? The chargeId that took the money.
    expect(t.booking["chargeId"]).toMatch(/^ch_/);
    expect(t.booking["reason"]).toMatch(/hold expired/);

    // 3. How did it get here? The charge succeeded, then the consume failed.
    const charge = t.events.find((e) => e.step === "chargeStep" && e.type === "step.succeeded");
    const consume = t.events.find((e) => e.step === "consumeStep" && e.type === "step.failed");
    expect(charge).toBeDefined();
    expect(consume).toBeDefined();
    expect(consume?.detail?.["error"]).toMatch(/hold expired/);

    // 4. And the terminal outcome is recorded by the runtime, not just by us.
    const settled = t.events.find((e) => e.type === "booking.settled");
    expect((settled?.detail?.["outcome"] as { state: string }).state).toBe(
      "charged_not_booked",
    );
  });
});

describe("timeline contract", () => {
  it("404s for an unknown booking", async () => {
    const res = await app.request("/bookings/bkg_does-not-exist/timeline");
    expect(res.status).toBe(404);

    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("booking_not_found");
  });
});
