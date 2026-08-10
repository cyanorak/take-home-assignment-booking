/**
 * POST /bookings — PLAN.md §12.1.
 *
 * Synchronous: awaits the workflow to a terminal state and returns it (A1).
 * The async machinery exists underneath — the timeline endpoint is the
 * re-check path — but the caller gets the answer directly.
 *
 * Order of operations matters and is not arbitrary:
 *   1. validate       — before claiming, so a malformed body cannot burn a key
 *   2. claim          — atomic, before any workflow exists (I4)
 *   3. create booking — bookingId must exist before any provider call (L2)
 *   4. start + await  — one run per key
 *   5. persist        — steps cannot write anything the handler can read
 *
 * V2 adds the claim, replay, and conflict. Failure arms arrive in V4.
 */
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { start } from "workflow/api";
import { bookingWorkflow } from "../workflows/booking.js";
import { fingerprint, validateBookingRequest } from "../domain/request.js";
import { applyOutcome, attachRun, createBooking } from "../store/bookings.js";
import { claim, settle, type IdempotencyRecord } from "../store/idempotency.js";
import { parseChaosHeader, type ChaosScript } from "../providers/chaos.js";
import {
  requiresIntervention,
  type BookingOutcome,
  type BookingRequest,
} from "../domain/types.js";

/** A fully-formed response, cached so a replay is byte-identical. */
type BookingResult = {
  status: ContentfulStatusCode;
  body: Record<string, unknown>;
};

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

  // Failure-mode config travels as a workflow argument, never as ambient
  // request state — steps run in a separate module instance and would never
  // see it otherwise (PLAN.md A18, verified in V1).
  //
  // Off in production unless ALLOW_CHAOS=true. See providers/chaos.ts.
  const script = parseChaosHeader(c.req.header("X-Chaos"));

  // Echo what was actually applied. Malformed clauses are ignored rather than
  // rejected, and chaos is gated by environment — without this, "my header did
  // nothing" is indistinguishable from "my header was wrong".
  if (c.req.header("X-Chaos")) {
    c.header("X-Chaos-Applied", JSON.stringify(script));
  }

  const request = validated.value;
  const claimed = claim<BookingResult>(idempotencyKey, fingerprint(request));

  if (claimed.outcome === "conflict") {
    // Same key, different request. Replaying the stored response would answer
    // a question this caller never asked — so refuse instead (I5).
    return c.json(
      {
        error: {
          code: "idempotency_key_reuse",
          message: "this Idempotency-Key was used with a different request body",
        },
        bookingId: claimed.record.bookingId,
      },
      409,
    );
  }

  if (claimed.outcome === "claimed") {
    // Assign the promise in the SAME synchronous turn as the claim: calling an
    // async function returns its promise immediately, so a concurrent duplicate
    // is guaranteed to find something to await rather than an empty record.
    const inflight = runBooking(idempotencyKey, request, claimed.record, script);
    claimed.record.inflight = inflight;
    const result = await inflight;
    return c.json(result.body, result.status);
  }

  // Duplicate: return exactly what the winner returned. Never start anything.
  const existing = claimed.record;
  const result = existing.result ?? (await existing.inflight!);
  return c.json(result.body, result.status);
});

async function runBooking(
  idempotencyKey: string,
  request: BookingRequest,
  record: IdempotencyRecord<BookingResult>,
  script: ChaosScript,
): Promise<BookingResult> {
  const booking = createBooking({
    ...request,
    idempotencyKey,
    fingerprint: record.fingerprint,
  });
  record.bookingId = booking.id;

  // bookingId is allocated and persisted before any provider call, because L2's
  // keys derive from it and must be stable across replays.
  const run = await start(bookingWorkflow, [
    booking.id,
    request.offerId,
    request.amountCents,
    request.currency,
    script,
  ]);
  record.runId = run.runId;
  attachRun(booking.id, run.runId);

  const outcome = (await run.returnValue) as BookingOutcome;
  const settled = applyOutcome(booking.id, outcome);

  const result: BookingResult = {
    status: 201,
    body: {
      bookingId: settled.id,
      state: settled.state,
      requiresIntervention: requiresIntervention(settled.state),
      holdId: settled.holdId,
      chargeId: settled.chargeId,
    },
  };
  settle(record, result);
  return result;
}
