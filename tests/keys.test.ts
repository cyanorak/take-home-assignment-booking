/**
 * L2 key derivation — frozen against expected values.
 *
 * The point of this test is not that the strings are pretty. It is that a
 * future change which reintroduces execution context (runId, stepId, attempt
 * number, a timestamp) into the key fails here rather than double-charging a
 * customer. See CORRECTNESS.md §3/L2.
 */
import { describe, it, expect } from "vitest";
import { providerIdempotencyKey } from "../src/domain/keys.js";

describe("providerIdempotencyKey", () => {
  it("matches the frozen table", () => {
    expect(providerIdempotencyKey("bkg_123", "hold")).toBe("bkg:bkg_123:hold");
    expect(providerIdempotencyKey("bkg_123", "charge")).toBe("bkg:bkg_123:charge");
  });

  it("is stable across calls — a retry sends the same key", () => {
    const first = providerIdempotencyKey("bkg_abc", "charge");
    const second = providerIdempotencyKey("bkg_abc", "charge");
    expect(first).toBe(second);
  });

  it("depends only on booking identity, not on when or how it is called", () => {
    // Same booking, different moments, different notional executions.
    const keys = new Set(
      Array.from({ length: 5 }, () => providerIdempotencyKey("bkg_same", "charge")),
    );
    expect(keys.size).toBe(1);
  });

  it("separates operations within one booking", () => {
    expect(providerIdempotencyKey("bkg_1", "hold")).not.toBe(
      providerIdempotencyKey("bkg_1", "charge"),
    );
  });

  it("separates bookings", () => {
    expect(providerIdempotencyKey("bkg_1", "charge")).not.toBe(
      providerIdempotencyKey("bkg_2", "charge"),
    );
  });
});
