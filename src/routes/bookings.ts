/**
 * POST /bookings — PLAN.md §12.1.
 *
 * Synchronous: awaits the workflow to a terminal state and returns it (A1).
 * The async machinery exists underneath — the timeline endpoint is the
 * re-check path — but the caller gets the answer directly.
 *
 * V1 handles the happy path. The L1 idempotency claim, replay, and fingerprint
 * conflict arrive in V2; the failure arms in V4.
 */
import { Hono } from "hono";
import { start } from "workflow/api";
import { bookingWorkflow } from "../workflows/booking.js";
import { fingerprint, validateBookingRequest } from "../domain/request.js";
import { applyOutcome, attachRun, createBooking } from "../store/bookings.js";
import { requiresIntervention, type BookingOutcome } from "../domain/types.js";

export const bookingsRouter = new Hono();

bookingsRouter.post("/bookings", async (c) => {
  // The header is required. Generating one server-side would silently disable
  // idempotency for a careless caller — the exact 2am bug class this service
  // exists to reason about (PLAN.md A2).
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (!idempotencyKey) {
    return c.json(
      { error: { code: "missing_idempotency_key", message: "Idempotency-Key header is required" } },
      400,
    );
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: { code: "invalid_json", message: "body must be valid JSON" } }, 400);
  }

  const validated = validateBookingRequest(body);
  if (!validated.ok) return c.json({ error: validated.error }, 400);

  const booking = createBooking({
    ...validated.value,
    idempotencyKey,
    fingerprint: fingerprint(validated.value),
  });

  // bookingId is allocated and persisted before any provider call, because L2's
  // keys derive from it and must be stable across replays.
  const run = await start(bookingWorkflow, [
    booking.id,
    validated.value.offerId,
    validated.value.amountCents,
    validated.value.currency,
  ]);
  attachRun(booking.id, run.runId);

  const outcome = (await run.returnValue) as BookingOutcome;
  const settled = applyOutcome(booking.id, outcome);

  return c.json(
    {
      bookingId: settled.id,
      state: settled.state,
      requiresIntervention: requiresIntervention(settled.state),
      holdId: settled.holdId,
      chargeId: settled.chargeId,
    },
    201,
  );
});
