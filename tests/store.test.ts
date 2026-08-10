/**
 * Direct unit tests for the three pieces that carry invariants but were only
 * ever exercised through HTTP: the request fingerprint (I5), the idempotency
 * claim (I4), and the state-transition guard (L4).
 *
 * These are worth having separately because an integration failure tells you
 * "the booking was wrong"; these tell you which primitive was wrong.
 */
import { describe, it, expect } from "vitest";
import { fingerprint, validateBookingRequest } from "../src/domain/request.js";
import { claim, settle } from "../src/store/idempotency.js";
import { createBooking, applyOutcome, getBooking } from "../src/store/bookings.js";
import { IllegalTransitionError } from "../src/domain/state.js";

const order = { offerId: "offer-1", amountCents: 100, currency: "GBP" };

describe("fingerprint — I5 rests on this", () => {
  it("is stable for the same request", () => {
    expect(fingerprint(order)).toBe(fingerprint({ ...order }));
  });

  it("changes when any meaningful field changes", () => {
    const base = fingerprint(order);
    expect(fingerprint({ ...order, offerId: "offer-2" })).not.toBe(base);
    expect(fingerprint({ ...order, amountCents: 101 })).not.toBe(base);
    expect(fingerprint({ ...order, currency: "USD" })).not.toBe(base);
  });

  it("does not collide across field boundaries", () => {
    // A naive concatenation would make these two identical.
    expect(fingerprint({ offerId: "a", amountCents: 1, currency: "GBP" })).not.toBe(
      fingerprint({ offerId: "a1", amountCents: 1, currency: "GBP" }),
    );
  });
});

describe("validateBookingRequest", () => {
  it("accepts a well-formed request", () => {
    const result = validateBookingRequest(order);
    expect(result.ok).toBe(true);
  });

  it.each([
    [null, "invalid_body"],
    ["a string", "invalid_body"],
    [{ ...order, offerId: "" }, "invalid_offer_id"],
    [{ ...order, amountCents: -1 }, "invalid_amount"],
    [{ ...order, amountCents: 1.5 }, "invalid_amount"],
    [{ ...order, currency: "gbp" }, "invalid_currency"],
    [{ ...order, currency: "POUNDS" }, "invalid_currency"],
  ])("rejects %s", (body, code) => {
    const result = validateBookingRequest(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });
});

describe("claim — I4 rests on this", () => {
  it("grants the first claim on a key", () => {
    const result = claim<string>("unit-claim-1", "fp-a");
    expect(result.outcome).toBe("claimed");
  });

  it("reports a duplicate for the same key and fingerprint", () => {
    claim<string>("unit-claim-2", "fp-a");
    const second = claim<string>("unit-claim-2", "fp-a");
    expect(second.outcome).toBe("exists");
  });

  it("reports a CONFLICT for the same key and a different fingerprint", () => {
    claim<string>("unit-claim-3", "fp-a");
    const second = claim<string>("unit-claim-3", "fp-b");
    expect(second.outcome).toBe("conflict");
  });

  it("returns the same record object, so the in-flight promise is shared", () => {
    const first = claim<string>("unit-claim-4", "fp-a");
    const second = claim<string>("unit-claim-4", "fp-a");
    expect(second.record).toBe(first.record);
  });

  it("keeps the settled result available for replay after completion", () => {
    const first = claim<string>("unit-claim-5", "fp-a");
    settle(first.record, "the-answer");

    const replay = claim<string>("unit-claim-5", "fp-a");
    expect(replay.outcome).toBe("exists");
    expect(replay.record.result).toBe("the-answer");
  });

  it("never mistakes one key for another", () => {
    claim<string>("unit-claim-6a", "fp-a");
    expect(claim<string>("unit-claim-6b", "fp-a").outcome).toBe("claimed");
  });
});

describe("applyOutcome — L4 has teeth", () => {
  function newBooking(key: string) {
    return createBooking({ ...order, idempotencyKey: key, fingerprint: "fp" });
  }

  it("settles a pending booking", () => {
    const booking = newBooking("unit-apply-1");
    const settled = applyOutcome(booking.id, { state: "confirmed", chargeId: "ch_1" });

    expect(settled.state).toBe("confirmed");
    expect(getBooking(booking.id)?.chargeId).toBe("ch_1");
  });

  it("refuses to re-settle a terminal booking", () => {
    // This is the failure a replay bug would produce: a second outcome
    // silently overwriting what actually happened to the customer.
    const booking = newBooking("unit-apply-2");
    applyOutcome(booking.id, { state: "confirmed", chargeId: "ch_1" });

    expect(() => applyOutcome(booking.id, { state: "charged_not_booked" })).toThrow(
      IllegalTransitionError,
    );
    // ...and the original outcome survives the attempt.
    expect(getBooking(booking.id)?.state).toBe("confirmed");
  });

  it("throws for an unknown booking rather than creating one", () => {
    expect(() => applyOutcome("bkg_nope", { state: "confirmed" })).toThrow(/unknown booking/);
  });
});
