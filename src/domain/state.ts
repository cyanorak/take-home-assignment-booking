/**
 * The booking state machine — PLAN.md §10.
 *
 * This is the definition of M6. Every quadrant of (charged | not) x
 * (booked | not) is a *named reachable state* with its own response arm, so
 * "handles the failure matrix" is something a test can check rather than
 * something the README asserts.
 *
 * One quadrant is missing on purpose. The order is hold -> charge -> consume,
 * so we only ever consume after a successful charge, and **booked-but-not-
 * charged is unreachable by construction**. Charging first would have put money
 * at risk instead of inventory for the same effort.
 */
import type { BookingState } from "./types.js";

export const TERMINAL_STATES = [
  "confirmed",
  "inventory_unavailable",
  "payment_failed",
  "charged_not_booked",
  "payment_pending",
] as const satisfies readonly BookingState[];

export function isTerminal(state: BookingState): boolean {
  return (TERMINAL_STATES as readonly BookingState[]).includes(state);
}

/**
 * States where a human must act — PLAN.md §10.2.1.
 *
 * Deliberately a flag rather than a state called `needs_manual_intervention`:
 * collapsing these two into one bucket would destroy the diagnosis, because
 * they need different actions. `charged_not_booked` needs a refund;
 * `payment_pending` needs someone to wait for the provider to settle. The state
 * names *what happened*, the flag says *who has to do something about it*.
 *
 * This is also the alerting signal — a metric or queue keys on it. That job
 * does NOT belong to the HTTP status code, which is why these return 409 and
 * not 500: a 5xx would trip retry middleware and bury a correct workflow
 * outcome in generic server-error noise.
 */
export const INTERVENTION_STATES = [
  "charged_not_booked",
  "payment_pending",
] as const satisfies readonly BookingState[];

export function requiresIntervention(state: BookingState): boolean {
  return (INTERVENTION_STATES as readonly BookingState[]).includes(state);
}

/** PLAN.md §10.2. `201` on success; everything else is a 4xx that names itself. */
export function httpStatusFor(state: BookingState): 201 | 402 | 409 | 500 {
  switch (state) {
    case "confirmed":
      return 201;
    case "payment_failed":
      return 402;
    case "inventory_unavailable":
    case "charged_not_booked":
    case "payment_pending":
      return 409;
    // In-flight states have no HTTP mapping: POST is synchronous, so a caller
    // never sees one. Reaching here means the workflow returned a non-terminal
    // state, which is a bug in us, not a condition in the world.
    case "pending":
    case "held":
    case "charged":
      return 500;
  }
}

/**
 * L4 — legal transitions, and nothing else.
 *
 * A note on what this does and does not enforce. The workflow computes its
 * outcome in one pass and returns it, so the *booking record* only ever moves
 * `pending -> <terminal>`; the intermediate `held` and `charged` states are
 * real but live in the runtime's step log rather than in our record. That is
 * fine — §10.2 already establishes no caller observes them — but it means this
 * table's job here is narrower than the full diagram: it stops a second outcome
 * being written over a settled booking, which is the failure a replay bug would
 * actually produce.
 */
const LEGAL_TRANSITIONS: Record<BookingState, readonly BookingState[]> = {
  pending: ["held", "charged", "confirmed", "inventory_unavailable", "payment_failed", "charged_not_booked", "payment_pending"],
  held: ["charged", "payment_failed", "payment_pending", "charged_not_booked", "confirmed"],
  charged: ["confirmed", "charged_not_booked"],
  // Terminal states have no outgoing transitions.
  confirmed: [],
  inventory_unavailable: [],
  payment_failed: [],
  charged_not_booked: [],
  payment_pending: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly bookingId: string,
    readonly from: BookingState,
    readonly to: BookingState,
  ) {
    super(`booking ${bookingId} cannot go from ${from} to ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export function assertTransition(
  bookingId: string,
  from: BookingState,
  to: BookingState,
): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new IllegalTransitionError(bookingId, from, to);
  }
}
