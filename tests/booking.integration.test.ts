/**
 * V1 — the walking skeleton: POST /bookings, happy path, end to end.
 *
 * Test isolation: mock provider state accumulates across tests within a file
 * (the Vitest plugin clears workflow data per file, not module state), so every
 * test uses distinct keys and offer ids. CORRECTNESS.md §4.3.
 */
import { describe, it, expect } from "vitest";
import { app } from "../src/index.js";

type BookingResponse = {
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

const validBody = (offerId: string) => ({
  offerId,
  amountCents: 12_500,
  currency: "GBP",
});

describe("POST /bookings — happy path", () => {
  it("holds, charges, consumes, and returns 201 confirmed", async () => {
    const res = await post("v1-happy", validBody("offer-v1-happy"));

    expect(res.status).toBe(201);

    const body = (await res.json()) as BookingResponse;
    expect(body.state).toBe("confirmed");
    expect(body.bookingId).toMatch(/^bkg_/);
    expect(body.holdId).toMatch(/^hold_/);
    expect(body.chargeId).toMatch(/^ch_/);

    // confirmed is not an intervention state — nobody needs to be paged.
    expect(body.requiresIntervention).toBe(false);
  });
});

describe("POST /bookings — request contract", () => {
  it("rejects a missing Idempotency-Key rather than inventing one", async () => {
    const res = await app.request("/bookings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody("offer-v1-nokey")),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("missing_idempotency_key");
  });

  it.each([
    ["missing offerId", { amountCents: 100, currency: "GBP" }, "invalid_offer_id"],
    ["zero amount", { offerId: "o", amountCents: 0, currency: "GBP" }, "invalid_amount"],
    ["fractional amount", { offerId: "o", amountCents: 1.5, currency: "GBP" }, "invalid_amount"],
    ["bad currency", { offerId: "o", amountCents: 100, currency: "pounds" }, "invalid_currency"],
  ])("rejects %s", async (_label, body, expectedCode) => {
    const res = await post(`v1-invalid-${expectedCode}-${_label}`, body);

    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe(expectedCode);
  });

  it("does not start a workflow for an invalid request", async () => {
    // Validation runs before the claim and before start() (PLAN.md §11.5), so
    // a bad body creates nothing at all.
    const { getWorld } = await import("workflow/runtime");
    const world = await getWorld();
    const before = (await world.runs.list({ resolveData: "none" })).data.length;

    await post("v1-no-run", { offerId: "", amountCents: -1, currency: "zz" });

    const after = (await world.runs.list({ resolveData: "none" })).data.length;
    expect(after).toBe(before);
  });
});
