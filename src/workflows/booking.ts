/**
 * The booking workflow — PLAN.md §11.
 *
 * Decomposition rule: a step boundary exists wherever an at-least-once retry
 * would otherwise duplicate a real-world side effect. That means exactly one
 * provider call per step, and the idempotency key passed *in* as an argument
 * rather than derived inside (so it is recorded in the step's persisted input —
 * CORRECTNESS.md §4.4).
 *
 * Steps are pure provider wrappers: no bookingId, no store access. They run in
 * a separate module instance from the HTTP handler and cannot write anything it
 * can read, so the workflow *returns* the outcome and the handler persists it.
 *
 * V1 implements the happy path only. Failure handling — try/catch returning
 * terminal records rather than throwing (§11.3) — arrives with V4.
 */
import { inventoryProvider } from "../providers/inventory.js";
import { paymentProvider } from "../providers/payment.js";
import { providerIdempotencyKey } from "../domain/keys.js";
import type { BookingOutcome, Charge, Hold } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Retry in the world: returns the SAME hold. The idempotency key makes a retry
 * a read-repair of the first attempt, so an unknown outcome (the call committed
 * but we never saw the response) cannot produce a second hold. Guarantees I2.
 */
export async function holdStep(
  offerId: string,
  idempotencyKey: string,
): Promise<Hold> {
  "use step";
  return inventoryProvider.hold(offerId, idempotencyKey);
}
holdStep.maxRetries = 3;

/**
 * Retry in the world: returns the SAME charge. This is the one that must never
 * duplicate — it is the customer's money. Guarantees I1, and it is what the
 * `applied_then_lost` failure mode attacks.
 */
export async function chargeStep(
  amountCents: number,
  currency: string,
  idempotencyKey: string,
): Promise<Charge> {
  "use step";
  return paymentProvider.charge(amountCents, currency, idempotencyKey);
}
chargeStep.maxRetries = 3;

/**
 * Retry in the world: no-op. The hold is already `consumed`, and the provider
 * treats a repeat transition on a named resource as success (PLAN.md A16) — no
 * idempotency key needed, because the holdId *is* the key.
 *
 * Highest retry budget of any step: it is the last thing between a committed
 * charge and `confirmed`, and every permanent failure here lands in
 * `charged_not_booked`, the one state that costs a human. Money is already
 * spent, so trying harder is nearly free.
 */
export async function consumeStep(holdId: string): Promise<void> {
  "use step";
  await inventoryProvider.consume(holdId);
}
consumeStep.maxRetries = 5;

// ---------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------

export async function bookingWorkflow(
  bookingId: string,
  offerId: string,
  amountCents: number,
  currency: string,
): Promise<BookingOutcome> {
  "use workflow";

  // Keys derive from the booking, never from the execution. Two runs for one
  // booking would produce identical keys — which is what makes L2 hold even
  // when L1 fails. See src/domain/keys.ts.
  const hold = await holdStep(offerId, providerIdempotencyKey(bookingId, "hold"));

  const charge = await chargeStep(
    amountCents,
    currency,
    providerIdempotencyKey(bookingId, "charge"),
  );

  await consumeStep(hold.holdId);

  return {
    state: "confirmed",
    holdId: hold.holdId,
    chargeId: charge.chargeId,
  };
}
