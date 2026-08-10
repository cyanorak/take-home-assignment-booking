/**
 * V4 — M6, the four-quadrant failure matrix, end to end.
 *
 * One test per terminal state. Each drives a real booking through the HTTP
 * layer with a scripted provider failure and asserts the whole contract: status
 * code, state, requiresIntervention, and the identifiers an on-call engineer
 * would need to act.
 *
 * The point of the matrix is that NOTHING falls through to an opaque 500.
 */
import { describe, it, expect } from "vitest";
import { app } from "../src/index.js";

type BookingBody = {
  bookingId: string;
  state: string;
  requiresIntervention: boolean;
  holdId?: string;
  chargeId?: string;
  reason?: string;
  holdReleased?: boolean;
};

async function book(key: string, offerId: string, chaos?: string) {
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
  return { res, body: (await res.json()) as BookingBody };
}

describe("quadrant: charged + booked", () => {
  it("confirmed, 201, no intervention", async () => {
    const { res, body } = await book("v4-confirmed", "offer-v4-confirmed");

    expect(res.status).toBe(201);
    expect(body.state).toBe("confirmed");
    expect(body.requiresIntervention).toBe(false);
    expect(body.holdId).toBeDefined();
    expect(body.chargeId).toBeDefined();
  });
});

describe("quadrant: not charged + not booked", () => {
  it("inventory_unavailable, 409, nothing charged", async () => {
    const { res, body } = await book(
      "v4-no-inventory",
      "offer-v4-no-inventory",
      "hold=permanent",
    );

    expect(res.status).toBe(409);
    expect(body.state).toBe("inventory_unavailable");
    expect(body.requiresIntervention).toBe(false);
    expect(body.chargeId).toBeUndefined(); // never got as far as charging
    expect(body.reason).toMatch(/sold out/);
  });

  it("payment_failed, 402, hold released", async () => {
    const { res, body } = await book(
      "v4-declined",
      "offer-v4-declined",
      "charge=permanent",
    );

    expect(res.status).toBe(402);
    expect(body.state).toBe("payment_failed");
    // A declined card is a normal business outcome, not a page.
    expect(body.requiresIntervention).toBe(false);
    expect(body.holdId).toBeDefined();
    // No money moved, so the inventory went back.
    expect(body.holdReleased).toBe(true);
    expect(body.reason).toMatch(/declined/);
  });

  it("payment_failed with holdReleased false when the release also fails", async () => {
    const { res, body } = await book(
      "v4-declined-stuck",
      "offer-v4-declined-stuck",
      "charge=permanent;release=permanent",
    );

    expect(res.status).toBe(402);
    expect(body.state).toBe("payment_failed");
    // A dangling hold is visible, but it expires on its own and no money is
    // involved — so it is recorded, not escalated (PLAN.md §10.4).
    expect(body.holdReleased).toBe(false);
    expect(body.requiresIntervention).toBe(false);
  });
});

describe("quadrant: charged + NOT booked — the one that costs a human", () => {
  it("charged_not_booked, 409, requiresIntervention with the chargeId", async () => {
    const { res, body } = await book(
      "v4-charged-not-booked",
      "offer-v4-cnb",
      "consume=permanent",
    );

    expect(res.status).toBe(409);
    expect(body.state).toBe("charged_not_booked");

    // The whole point of M6: never silent. The state names itself, the flag
    // routes it to a human, and the chargeId is what they need to act.
    expect(body.requiresIntervention).toBe(true);
    expect(body.chargeId).toBeDefined();
    expect(body.holdId).toBeDefined();
    expect(body.reason).toBeDefined();

    // Explicitly NOT a 500. We understand this state precisely.
    expect(res.status).toBeLessThan(500);
  });
});

describe("charge outcome unknown", () => {
  it("payment_pending, 409, requiresIntervention, hold NOT released", async () => {
    const { res, body } = await book(
      "v4-pending",
      "offer-v4-pending",
      "charge=pending",
    );

    expect(res.status).toBe(409);
    expect(body.state).toBe("payment_pending");
    expect(body.requiresIntervention).toBe(true);
    expect(body.chargeId).toBeDefined();

    // Deliberately asymmetric with payment_failed: the charge may still settle,
    // so releasing inventory we might owe the customer would turn an uncertain
    // state into a definitely-broken one.
    expect(body.holdReleased).toBeUndefined();
  });
});

describe("the matrix is exhaustive", () => {
  it("never returns 5xx for any scripted provider failure", async () => {
    const scenarios = [
      ["v4-x-1", "hold=permanent"],
      ["v4-x-2", "charge=permanent"],
      ["v4-x-3", "consume=permanent"],
      ["v4-x-4", "charge=pending"],
      ["v4-x-5", "hold=http_5xx,http_5xx,http_5xx,http_5xx"], // exhausts retries
      ["v4-x-6", "consume=applied_then_lost"],
    ] as const;

    for (const [key, chaos] of scenarios) {
      const { res, body } = await book(key, `offer-${key}`, chaos);
      expect(res.status, `${chaos} produced ${res.status}`).toBeLessThan(500);
      expect(body.state, `${chaos} produced no state`).toBeDefined();
    }
  });
});
