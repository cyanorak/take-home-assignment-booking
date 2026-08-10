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

/**
 * The interfaces as given in the assignment, plus one mock-only extension: a
 * trailing `script` argument that configures failure modes (PLAN.md A9). It is
 * optional and last, so the given contract still type-checks unchanged. A real
 * provider would not have it — the failure modes would be the world's.
 *
 * Note what is NOT extended: `release`, `consume`, and `refund` still take no
 * idempotency key. That asymmetry is principled, not an oversight — keyed calls
 * CREATE a resource, unkeyed calls TRANSITION a named one, and the resource id
 * is already the key. See PLAN.md A16.
 */
export interface InventoryProvider {
  hold(offerId: string, idempotencyKey: string, script?: MockScript): Promise<Hold>;
  release(holdId: string, script?: MockScript): Promise<void>;
  consume(holdId: string, script?: MockScript): Promise<void>;
}

export interface PaymentProvider {
  charge(
    amountCents: number,
    currency: string,
    idempotencyKey: string,
    script?: MockScript,
  ): Promise<Charge>;
  refund(chargeId: string, script?: MockScript): Promise<void>;
}

/** Ordered failure outcomes for a single provider method. See providers/chaos.ts. */
export type MockScript = readonly string[];

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

/** The state machine itself — transitions, HTTP mapping — lives in ./state.ts. */

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
