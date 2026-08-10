/**
 * Unit tests for the failure-mode mechanism and provider idempotency (M4/M5).
 *
 * These run without the workflow runtime, so provider state is directly
 * observable — which is exactly what makes "exactly one charge" assertable
 * here rather than inferred through the runtime.
 */
import { describe, it, expect } from "vitest";
import { parseChaosHeader } from "../src/providers/chaos.js";
import { paymentProvider, countCharges, inspectCharge } from "../src/providers/payment.js";
import { inventoryProvider, inspectHold } from "../src/providers/inventory.js";

describe("parseChaosHeader", () => {
  it("parses a single method", () => {
    expect(parseChaosHeader("charge=timeout")).toEqual({ charge: ["timeout"] });
  });

  it("parses an ordered list — 'fail once, then succeed'", () => {
    expect(parseChaosHeader("charge=http_5xx,ok")).toEqual({
      charge: ["http_5xx", "ok"],
    });
  });

  it("parses several methods", () => {
    expect(parseChaosHeader("hold=permanent;charge=applied_then_lost")).toEqual({
      hold: ["permanent"],
      charge: ["applied_then_lost"],
    });
  });

  it("ignores unknown methods and outcomes rather than failing the booking", () => {
    // A malformed debugging header must not take down a real request.
    expect(parseChaosHeader("nonsense=ok;charge=not_a_mode,timeout")).toEqual({
      charge: ["timeout"],
    });
  });

  it("treats a missing header as no chaos", () => {
    expect(parseChaosHeader(undefined)).toEqual({});
    expect(parseChaosHeader("")).toEqual({});
  });
});

describe("M4 — provider idempotency", () => {
  it("charge() with the same key produces ONE charge", async () => {
    const key = "unit:charge:same-key";
    const before = countCharges();

    const first = await paymentProvider.charge(5000, "GBP", key);
    const second = await paymentProvider.charge(5000, "GBP", key);

    expect(second.chargeId).toBe(first.chargeId);
    expect(countCharges()).toBe(before + 1);
  });

  it("charge() with different keys produces two charges", async () => {
    const before = countCharges();
    await paymentProvider.charge(5000, "GBP", "unit:charge:key-a");
    await paymentProvider.charge(5000, "GBP", "unit:charge:key-b");
    expect(countCharges()).toBe(before + 2);
  });

  it("applied_then_lost commits the charge, then fails — and the retry finds it", async () => {
    const key = "unit:charge:lost";
    const before = countCharges();

    // First attempt: the provider commits and then loses the response. The
    // caller cannot distinguish this from "never happened".
    await expect(
      paymentProvider.charge(7500, "GBP", key, ["applied_then_lost"]),
    ).rejects.toThrow(/lost after commit/);

    // The charge exists despite the caller seeing an error. This is the state
    // the whole exercise is about.
    expect(countCharges()).toBe(before + 1);

    // The retry read-repairs rather than charging again — I1.
    const recovered = await paymentProvider.charge(7500, "GBP", key, ["applied_then_lost"]);
    expect(recovered.amountCents).toBe(7500);
    expect(countCharges()).toBe(before + 1);
    expect(inspectCharge(recovered.chargeId)?.status).toBe("succeeded");
  });

  it("a pending charge stays pending on retry — no scheme can resolve it", async () => {
    const key = "unit:charge:pending";
    const first = await paymentProvider.charge(300, "GBP", key, ["pending"]);
    expect(first.status).toBe("pending");

    // Read-repair returns the same record, still pending. CORRECTNESS §3.3(b).
    const second = await paymentProvider.charge(300, "GBP", key, ["ok"]);
    expect(second.chargeId).toBe(first.chargeId);
    expect(second.status).toBe("pending");
  });
});

describe("M4 — inventory transitions are idempotent by resource identity", () => {
  it("hold() with the same key produces ONE hold", async () => {
    const key = "unit:hold:same-key";
    const first = await inventoryProvider.hold("offer-unit", key);
    const second = await inventoryProvider.hold("offer-unit", key);
    expect(second.holdId).toBe(first.holdId);
  });

  it("consume() twice is a no-op the second time — no key required", async () => {
    const hold = await inventoryProvider.hold("offer-unit-2", "unit:hold:consume");
    await inventoryProvider.consume(hold.holdId);
    await expect(inventoryProvider.consume(hold.holdId)).resolves.toBeUndefined();
    expect(inspectHold(hold.holdId)?.status).toBe("consumed");
  });

  it("release() on a consumed hold is an error, not a silent no-op", async () => {
    const hold = await inventoryProvider.hold("offer-unit-3", "unit:hold:illegal");
    await inventoryProvider.consume(hold.holdId);
    await expect(inventoryProvider.release(hold.holdId)).rejects.toThrow(
      /cannot go from consumed to released/,
    );
  });

  it("applied_then_lost on consume commits, then the retry no-ops", async () => {
    const hold = await inventoryProvider.hold("offer-unit-4", "unit:hold:lost-consume");

    await expect(
      inventoryProvider.consume(hold.holdId, ["applied_then_lost"]),
    ).rejects.toThrow(/lost after commit/);

    expect(inspectHold(hold.holdId)?.status).toBe("consumed");
    await expect(inventoryProvider.consume(hold.holdId)).resolves.toBeUndefined();
  });
});
