/**
 * GET /bookings/:id/timeline — PLAN.md §12.2, M8.
 *
 * "What happened to booking ABC-123?", answerable without spelunking through
 * stdout. The envelope leads with the booking's current state and why, so the
 * 2am question is answered before you read a single event; the events are there
 * to show how it got there.
 *
 * `:id` is the server-generated bookingId, not the Idempotency-Key — keys are
 * caller-controlled, and putting them in URLs conflates "the request that
 * asked" with "the thing that exists" (PLAN.md A6).
 */
import { Hono } from "hono";
import { buildTimeline } from "../domain/timeline.js";
import { getBooking } from "../store/bookings.js";

export const timelineRouter = new Hono();

timelineRouter.get("/bookings/:id/timeline", async (c) => {
  const booking = getBooking(c.req.param("id"));

  if (!booking) {
    return c.json(
      { error: { code: "booking_not_found", message: "no booking with that id" } },
      404,
    );
  }

  return c.json(await buildTimeline(booking));
});
