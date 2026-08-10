/** Provider contracts — shapes given in the assignment. */

export type HoldStatus = "held" | "released" | "consumed";

export type Hold = {
  holdId: string;
  offerId: string;
  status: HoldStatus;
  expiresAt: string;
};

export type ChargeStatus = "succeeded" | "failed" | "pending";

export type Charge = {
  chargeId: string;
  amountCents: number;
  currency: string;
  status: ChargeStatus;
  idempotencyKey: string;
};

export interface InventoryProvider {
  hold(offerId: string, idempotencyKey: string): Promise<Hold>;
  release(holdId: string): Promise<void>;
  consume(holdId: string): Promise<void>;
}

export interface PaymentProvider {
  charge(
    amountCents: number,
    currency: string,
    idempotencyKey: string,
  ): Promise<Charge>;
  refund(chargeId: string): Promise<void>;
}

/**
 * Booking states — PLAN.md §10.2. Every quadrant of the (charged | not) x
 * (booked | not) matrix is a named state, so "handles the matrix" is testable.
 *
 * V1 reaches only `pending` and `confirmed`; the failure states become
 * reachable in V4.
 */
export type BookingState =
  // in-flight — never observed by a caller, since POST is synchronous
  | "pending"
  | "held"
  | "charged"
  // terminal
  | "confirmed"
  | "inventory_unavailable"
  | "payment_failed"
  | "charged_not_booked"
  | "payment_pending";

export const TERMINAL_STATES = [
  "confirmed",
  "inventory_unavailable",
  "payment_failed",
  "charged_not_booked",
  "payment_pending",
] as const satisfies readonly BookingState[];

/** States where a human must act — PLAN.md §10.2.1. The alerting signal. */
export const INTERVENTION_STATES = [
  "charged_not_booked",
  "payment_pending",
] as const satisfies readonly BookingState[];

export function requiresIntervention(state: BookingState): boolean {
  return (INTERVENTION_STATES as readonly BookingState[]).includes(state);
}

/** What a booking workflow returns. The handler persists this. */
export type BookingOutcome = {
  state: BookingState;
  holdId?: string;
  chargeId?: string;
  /** Human-readable cause, for the on-call engineer. Not for branching. */
  reason?: string;
  /** Only meaningful for `payment_failed` — PLAN.md §10.4. */
  holdReleased?: boolean;
};

export type Booking = BookingOutcome & {
  id: string;
  idempotencyKey: string;
  /** Stable hash of the canonicalised request body — PLAN.md A3. */
  fingerprint: string;
  offerId: string;
  amountCents: number;
  currency: string;
  /** Needed by the timeline endpoint to reach world.events.list(). */
  runId?: string;
  createdAt: string;
  updatedAt: string;
};

export type BookingRequest = {
  offerId: string;
  amountCents: number;
  currency: string;
};
