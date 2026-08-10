/**
 * The booking state machine — PLAN.md §10.
 */
import { describe, it, expect } from "vitest";
import {
  assertTransition,
  httpStatusFor,
  isTerminal,
  requiresIntervention,
  TERMINAL_STATES,
  INTERVENTION_STATES,
} from "../src/domain/state.js";
import type { BookingState } from "../src/domain/types.js";

describe("M6 — the four quadrants have named states", () => {
  it.each([
    ["charged + booked", "confirmed", 201, false],
    ["not charged + not booked (hold failed)", "inventory_unavailable", 409, false],
    ["not charged + not booked (charge failed)", "payment_failed", 402, false],
    ["charged + NOT booked", "charged_not_booked", 409, true],
    ["charge outcome unknown", "payment_pending", 409, true],
  ] as const)("%s -> %s", (_quadrant, state, status, intervention) => {
    expect(httpStatusFor(state)).toBe(status);
    expect(requiresIntervention(state)).toBe(intervention);
    expect(isTerminal(state)).toBe(true);
  });

  it("has no state for booked-but-not-charged, because it is unreachable", () => {
    // hold -> charge -> consume means we only consume after a successful
    // charge. The quadrant is closed by ordering, not by handling it.
    expect(TERMINAL_STATES).not.toContain("booked_not_charged");
    expect(TERMINAL_STATES).toHaveLength(5);
  });
});

describe("requiresIntervention is the alerting signal", () => {
  it("is true exactly for the states where money is at risk or unknown", () => {
    expect([...INTERVENTION_STATES].sort()).toEqual(
      ["charged_not_booked", "payment_pending"].sort(),
    );
  });

  it("is false for clean failures — nobody should be paged for a declined card", () => {
    expect(requiresIntervention("payment_failed")).toBe(false);
    expect(requiresIntervention("inventory_unavailable")).toBe(false);
  });

  it("never maps an intervention state to 5xx", () => {
    // A 5xx would trip retry middleware and bury a correct workflow outcome in
    // generic server-error noise. The flag is the signal, not the status line.
    for (const state of INTERVENTION_STATES) {
      expect(httpStatusFor(state)).toBeLessThan(500);
    }
  });
});

describe("in-flight states have no caller-facing mapping", () => {
  it.each(["pending", "held", "charged"] as const)(
    "%s is not terminal and maps to 500 if it ever escaped",
    (state) => {
      expect(isTerminal(state)).toBe(false);
      // POST is synchronous, so a caller never sees these. Reaching here means
      // the workflow returned a non-terminal state — a bug in us.
      expect(httpStatusFor(state)).toBe(500);
    },
  );
});

describe("L4 — legal transitions", () => {
  it("allows pending -> any terminal state", () => {
    for (const state of TERMINAL_STATES) {
      expect(() => assertTransition("bkg_1", "pending", state)).not.toThrow();
    }
  });

  it("refuses to re-settle a terminal booking", () => {
    // This is the failure a replay bug would produce: a second outcome written
    // over a settled booking, silently rewriting what happened.
    expect(() => assertTransition("bkg_1", "confirmed", "charged_not_booked")).toThrow(
      /cannot go from confirmed to charged_not_booked/,
    );
    expect(() => assertTransition("bkg_1", "payment_failed", "confirmed")).toThrow();
  });

  it("refuses to un-charge a booking", () => {
    expect(() => assertTransition("bkg_1", "charged", "inventory_unavailable")).toThrow();
  });

  it("gives terminal states no outgoing transitions at all", () => {
    for (const from of TERMINAL_STATES) {
      for (const to of TERMINAL_STATES) {
        expect(() => assertTransition("bkg_1", from, to as BookingState)).toThrow();
      }
    }
  });
});
