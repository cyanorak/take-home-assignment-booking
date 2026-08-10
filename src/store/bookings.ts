/**
 * Booking store — handler-side, in-memory.
 *
 * Single process, deliberately (PLAN.md §1.1). This is only ever touched by the
 * HTTP handler: steps run in a separate module instance and would write to a
 * copy nobody can read.
 */
import type { Booking, BookingOutcome, BookingRequest } from "../domain/types.js";
import { assertTransition } from "../domain/state.js";

const bookings = new Map<string, Booking>();

export function createBooking(
  input: BookingRequest & { idempotencyKey: string; fingerprint: string },
): Booking {
  const now = new Date().toISOString();
  const booking: Booking = {
    id: `bkg_${crypto.randomUUID()}`,
    state: "pending",
    idempotencyKey: input.idempotencyKey,
    fingerprint: input.fingerprint,
    offerId: input.offerId,
    amountCents: input.amountCents,
    currency: input.currency,
    createdAt: now,
    updatedAt: now,
  };
  bookings.set(booking.id, booking);
  return booking;
}

/** Records the runId once start() resolves — the timeline endpoint needs it. */
export function attachRun(bookingId: string, runId: string): void {
  const booking = bookings.get(bookingId);
  if (!booking) return;
  booking.runId = runId;
  booking.updatedAt = new Date().toISOString();
}

/**
 * Applies the workflow's returned outcome. PLAN.md §11.1.
 *
 * Guarded by the state machine (L4): writing a second outcome over a settled
 * booking is an illegal transition and throws. Terminal states have no outgoing
 * transitions, so a replay bug that tried to re-settle a booking would fail
 * loudly here rather than quietly overwriting what actually happened.
 */
export function applyOutcome(
  bookingId: string,
  outcome: BookingOutcome,
): Booking {
  const booking = bookings.get(bookingId);
  if (!booking) throw new Error(`unknown booking: ${bookingId}`);
  assertTransition(bookingId, booking.state, outcome.state);
  Object.assign(booking, outcome, { updatedAt: new Date().toISOString() });
  return booking;
}

export function getBooking(bookingId: string): Booking | undefined {
  return bookings.get(bookingId);
}
