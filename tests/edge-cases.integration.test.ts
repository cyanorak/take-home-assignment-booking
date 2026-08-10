/**
 * Edge cases — the gaps between the tests written per-vertical.
 *
 * Each vertical tested its own feature. These probe the *interactions*: replay
 * of a failure, concurrency when the workflow fails, what the fingerprint
 * actually covers, and what the timeline looks like for a booking that never
 * got as far as charging.
 */
import { describe, it, expect } from "vitest";
import { getWorld } from "workflow/runtime";
import { app } from "../src/index.js";

type Body = Record<string, unknown>;

async function post(
  key: string,
  body: unknown,
  chaos?: string,
): Promise<{ status: number; body: Body }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "Idempotency-Key": key,
  };
  if (chaos) headers["X-Chaos"] = chaos;

  const res = await app.request("/bookings", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Body };
}

const order = (offerId: string, amountCents = 12_500) => ({
  offerId,
  amountCents,
  currency: "GBP",
});

/** Paginated — a single page saturates once history grows (CORRECTNESS §4.3). */
async function runCount(): Promise<number> {
  const world = await getWorld();
  let count = 0;
  let cursor: string | null | undefined;
  do {
    const page = await world.runs.list({
      resolveData: "none",
      ...(cursor ? { pagination: { cursor } } : {}),
    });
    count += page.data.filter((r) => r.workflowName.endsWith("bookingWorkflow")).length;
    cursor = page.cursor;
  } while (cursor);
  return count;
}

describe("replay of a FAILED booking", () => {
  it("replays a 402 exactly, rather than retrying the charge", async () => {
    const key = "edge-replay-402";
    const payload = order("offer-edge-402");

    const first = await post(key, payload, "charge=permanent");
    expect(first.status).toBe(402);
    expect(first.body["state"]).toBe("payment_failed");

    // I5 applies to failures too. A caller retrying after a decline must not
    // silently get a *different* answer, or a second charge attempt.
    const second = await post(key, payload);
    expect(second.status).toBe(402);
    expect(second.body).toEqual(first.body);
  });

  it("replays an intervention state, keeping requiresIntervention set", async () => {
    const key = "edge-replay-cnb";
    const payload = order("offer-edge-cnb");

    const first = await post(key, payload, "consume=permanent");
    expect(first.body["state"]).toBe("charged_not_booked");

    const second = await post(key, payload);
    expect(second.body).toEqual(first.body);
    expect(second.body["requiresIntervention"]).toBe(true);
  });
});

describe("concurrency when the booking FAILS", () => {
  it("gives both concurrent callers the identical failure", async () => {
    const key = "edge-concurrent-fail";
    const payload = order("offer-edge-cfail");

    const [a, b] = await Promise.all([
      post(key, payload, "charge=permanent"),
      post(key, payload, "charge=permanent"),
    ]);

    // The loser awaits the winner's in-flight promise, so it sees the same
    // failure rather than starting its own run and charging again.
    expect(a.status).toBe(402);
    expect(b.status).toBe(402);
    expect(b.body).toEqual(a.body);
  });

  it("still starts exactly one run when the booking fails", async () => {
    // Identical responses alone would pass even if two runs raced and both
    // failed the same way. The run count is what rules that out.
    const before = await runCount();

    await Promise.all([
      post("edge-concurrent-fail-count", order("offer-edge-cfc"), "hold=permanent"),
      post("edge-concurrent-fail-count", order("offer-edge-cfc"), "hold=permanent"),
    ]);

    expect(await runCount()).toBe(before + 1);
  });
});

describe("the NEGATIVE control for idempotency", () => {
  it("does NOT deduplicate distinct requests", async () => {
    // T-conc-1 proves we collapse duplicates. On its own that is only half the
    // claim: an implementation that returned one booking for *everything*
    // would pass it. This is the other half.
    const before = await runCount();

    const [a, b] = await Promise.all([
      post("edge-distinct-a", order("offer-edge-distinct-a")),
      post("edge-distinct-b", order("offer-edge-distinct-b")),
    ]);

    expect(a.body["bookingId"]).not.toBe(b.body["bookingId"]);
    expect(a.body["chargeId"]).not.toBe(b.body["chargeId"]);
    expect(a.body["holdId"]).not.toBe(b.body["holdId"]);
    expect(await runCount()).toBe(before + 2);
  });

  it("does not deduplicate the same key across different bodies", async () => {
    // Already covered as a 409, but stated here as the counterpart: sharing a
    // key must never silently share a booking.
    const first = await post("edge-distinct-c", order("offer-edge-dc", 100));
    const second = await post("edge-distinct-c", order("offer-edge-dc", 200));
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body["state"]).toBeUndefined();
  });
});

describe("I3 as a property, not an instance", () => {
  it("never leaves money taken without either a booking or a flag", async () => {
    // The quadrant tests assert one state each. This asserts the invariant
    // across all of them: if we hold a charge and the booking is not
    // confirmed, a human must have been told.
    const scenarios = [
      ["edge-i3-1", undefined],
      ["edge-i3-2", "hold=permanent"],
      ["edge-i3-3", "charge=permanent"],
      ["edge-i3-4", "consume=permanent"],
      ["edge-i3-5", "charge=pending"],
      ["edge-i3-6", "charge=applied_then_lost"],
      ["edge-i3-7", "consume=applied_then_lost"],
      ["edge-i3-8", "charge=permanent;release=permanent"],
    ] as const;

    for (const [key, chaos] of scenarios) {
      const { status, body } = await post(key, order(`offer-${key}`), chaos);
      const state = body["state"] as string;
      const charged = Boolean(body["chargeId"]);
      const intervention = body["requiresIntervention"];

      // Nothing we understand is reported as a server error.
      expect(status, `${chaos} -> ${status}`).toBeLessThan(500);
      expect(state, `${chaos} produced no state`).toBeDefined();

      if (charged && state !== "confirmed") {
        // Money is held and the customer has no booking. I3 requires this to
        // be visible, not silent.
        expect(intervention, `${state} holds a charge but does not flag it`).toBe(true);
      }
      if (state === "confirmed") {
        expect(intervention).toBe(false);
        expect(charged).toBe(true);
      }
    }
  });
});

describe("what the fingerprint actually covers", () => {
  it("ignores fields the service does not use", async () => {
    const key = "edge-extra-fields";

    const first = await post(key, order("offer-edge-extra"));
    expect(first.status).toBe(201);

    // The fingerprint canonicalises the fields that determine the booking, not
    // the raw bytes. An extra field the service ignores cannot change the
    // outcome, so treating it as a different request would be a false conflict.
    const second = await post(key, { ...order("offer-edge-extra"), tracking: "abc" });
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body);
  });

  it("does NOT include the X-Chaos header", async () => {
    const key = "edge-chaos-fingerprint";
    const payload = order("offer-edge-chaosfp");

    const first = await post(key, payload, "charge=permanent");
    expect(first.status).toBe(402);

    // X-Chaos is a debugging affordance, not part of the request contract, so
    // it must not turn a replay into a conflict. The stored result is replayed.
    const second = await post(key, payload, "charge=ok");
    expect(second.body).toEqual(first.body);
  });

  it("treats currency as significant", async () => {
    const key = "edge-currency";
    await post(key, { offerId: "offer-edge-cur", amountCents: 100, currency: "GBP" });
    const conflict = await post(key, {
      offerId: "offer-edge-cur",
      amountCents: 100,
      currency: "USD",
    });
    expect(conflict.status).toBe(409);
  });
});

describe("exhausting a retry budget", () => {
  it("lands in charged_not_booked when consume never recovers", async () => {
    // consumeStep has the highest budget (5). Six transient failures exhaust
    // it, and the workflow must still return a named state rather than throw.
    const { status, body } = await post(
      "edge-consume-exhausted",
      order("offer-edge-exhaust"),
      "consume=http_5xx,http_5xx,http_5xx,http_5xx,http_5xx,http_5xx",
    );

    expect(status).toBe(409);
    expect(body["state"]).toBe("charged_not_booked");
    expect(body["requiresIntervention"]).toBe(true);
    expect(body["chargeId"]).toBeDefined();
  });
});

describe("A16 — transitions are idempotent by resource identity", () => {
  it("recovers a lost release response without a second release", async () => {
    // release() takes no idempotency key: the holdId IS the key. Commit-then-
    // lose must therefore still resolve, via the provider treating a repeat
    // transition on an already-released hold as a no-op.
    const { status, body } = await post(
      "edge-release-lost",
      order("offer-edge-relost"),
      "charge=permanent;release=applied_then_lost",
    );

    expect(status).toBe(402);
    expect(body["state"]).toBe("payment_failed");
    expect(body["holdReleased"]).toBe(true);
  });
});

describe("timeline of a booking that never charged", () => {
  it("has no charge step and no chargeId", async () => {
    const { body } = await post(
      "edge-tl-nohold",
      order("offer-edge-tlnohold"),
      "hold=permanent",
    );
    const id = body["bookingId"] as string;

    const res = await app.request(`/bookings/${id}/timeline`);
    const t = (await res.json()) as {
      booking: Body;
      events: { type: string; step?: string }[];
    };

    expect(t.booking["state"]).toBe("inventory_unavailable");
    expect(t.booking["chargeId"]).toBeUndefined();

    const steps = t.events.filter((e) => e.step).map((e) => e.step);
    expect(steps).toContain("holdStep");
    expect(steps).not.toContain("chargeStep");

    // The failure is still explained.
    const failed = t.events.find((e) => e.type === "step.failed");
    expect(failed?.step).toBe("holdStep");
  });
});

describe("input robustness", () => {
  it("rejects an empty Idempotency-Key rather than treating it as present", async () => {
    const res = await app.request("/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "" },
      body: JSON.stringify(order("offer-edge-emptykey")),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-object body", async () => {
    const res = await app.request("/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "edge-arr" },
      body: JSON.stringify([1, 2, 3]),
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed JSON without starting anything", async () => {
    const res = await app.request("/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "edge-badjson" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("accepts an idempotency key with awkward characters", async () => {
    // Format validation was deliberately cut: one trusted caller is assumed,
    // and the key only ever becomes a Map key (PLAN.md A2).
    const key = "edge/../weird key:with spaces#and?punctuation";
    const first = await post(key, order("offer-edge-weirdkey"));
    expect(first.status).toBe(201);

    const replay = await post(key, order("offer-edge-weirdkey"));
    expect(replay.body).toEqual(first.body);
  });
});
