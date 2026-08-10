/**
 * The audit timeline — PLAN.md §12.2, A12.
 *
 * Projected from artifacts we are already producing: the runtime's own event
 * log, plus the booking record. There is **no audit log of our own** — the
 * assignment is explicit that a separate audit table is the wrong answer, and
 * a step's persisted input/output already *is* the provider-call record.
 *
 * What goes in is a judgement call, and the brief says so: "pick what's
 * actually useful for someone investigating, not everything that ever
 * happened." So this projection drops as much as it keeps —
 *
 *   dropped: run_started (always follows run_created), step_started (the
 *            attempt boundary is already visible from retries and outcomes),
 *            stack traces (ten lines of node_modules paths per error), and the
 *            chaos script (a mock-only artifact that would not exist in
 *            production).
 *
 *   kept:    what was sent, what came back, which idempotency key was used,
 *            every retry with its reason and backoff, how long each step took,
 *            and the final state with the reason it was reached.
 */
import { getWorld } from "workflow/runtime";
import { hydrateResourceIO, observabilityRevivers } from "workflow/observability";
import { requiresIntervention } from "./state.js";
import type { Booking } from "./types.js";

export type TimelineEventType =
  | "booking.created"
  | "workflow.started"
  | "step.started"
  | "step.retrying"
  | "step.succeeded"
  | "step.failed"
  | "booking.settled";

export type TimelineEvent = {
  at: string;
  type: TimelineEventType;
  /** Short step name, e.g. "chargeStep". */
  step?: string;
  /** The key sent to the provider, when this event involved one. */
  idempotencyKey?: string;
  durationMs?: number;
  detail?: Record<string, unknown>;
};

export type Timeline = {
  booking: Record<string, unknown>;
  runId?: string;
  events: TimelineEvent[];
};

/** "step//./src/workflows/booking//chargeStep" -> "chargeStep" */
function shortName(qualified: unknown): string | undefined {
  if (typeof qualified !== "string") return undefined;
  const parts = qualified.split("//");
  return parts[parts.length - 1] || qualified;
}

/**
 * Provider arguments, minus the chaos script.
 *
 * Every real argument our steps take is a primitive; the only object is the
 * mock-only failure script, which would not exist in production and is noise
 * in an audit trail.
 */
function providerArgs(input: unknown): unknown[] {
  const args = (input as { args?: unknown[] } | undefined)?.args;
  if (!Array.isArray(args)) return [];
  return args.filter((a) => typeof a !== "object" || a === null);
}

/** Finds the idempotency key among a step's arguments, without relying on position. */
function keyFrom(args: unknown[]): string | undefined {
  return args.find(
    (a): a is string => typeof a === "string" && /^bkg:.+:(hold|charge)$/.test(a),
  );
}

type RawEvent = {
  eventType: string;
  /** The runtime hands back a Date here, not a string — normalise it. */
  createdAt?: Date | string;
  correlationId?: string;
  eventData?: Record<string, unknown>;
};

/**
 * Every `at` in the timeline is an ISO string.
 *
 * Caught by the typechecker, not by the tests: the runtime returns `Date`
 * objects, and JSON serialisation quietly turned them into ISO strings on the
 * way out. The tests passed while the in-process type was wrong, which would
 * have bitten anyone consuming buildTimeline() directly.
 */
function iso(value: Date | string | undefined, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  return value ?? fallback;
}

/** Follows the cursor. A single page silently truncates a busy booking. */
async function allEvents(runId: string): Promise<RawEvent[]> {
  const world = await getWorld();
  const collected: RawEvent[] = [];
  let cursor: string | null | undefined;

  do {
    const page = await world.events.list({
      runId,
      ...(cursor ? { pagination: { cursor } } : {}),
    });
    for (const event of page.data) {
      collected.push(hydrateResourceIO(event, observabilityRevivers) as unknown as RawEvent);
    }
    cursor = page.cursor;
  } while (cursor);

  return collected;
}

function elapsed(from: string | undefined, to: string | undefined): number | undefined {
  if (!from || !to) return undefined;
  return new Date(to).getTime() - new Date(from).getTime();
}

export async function buildTimeline(booking: Booking): Promise<Timeline> {
  const events: TimelineEvent[] = [
    {
      at: booking.createdAt,
      type: "booking.created",
      detail: {
        idempotencyKey: booking.idempotencyKey,
        fingerprint: booking.fingerprint,
        offerId: booking.offerId,
        amountCents: booking.amountCents,
        currency: booking.currency,
      },
    },
  ];

  if (booking.runId) {
    const raw = await allEvents(booking.runId);

    // Step timings are reconstructed by correlationId: the runtime emits
    // step_created / step_retrying / step_completed for one logical step, and
    // the span from created to settled is what "how long did this take"
    // actually means — including the retries, which is the honest number.
    const startedAt = new Map<string, string>();
    const keyFor = new Map<string, string | undefined>();

    for (const event of raw) {
      const at = iso(event.createdAt, booking.createdAt);
      const data = event.eventData ?? {};
      const corr = event.correlationId ?? "";
      const step = shortName(data["stepName"]);

      switch (event.eventType) {
        case "run_created": {
          events.push({ at, type: "workflow.started", detail: { runId: booking.runId } });
          break;
        }
        case "step_created": {
          const args = providerArgs(data["input"]);
          const key = keyFrom(args);
          startedAt.set(corr, at);
          keyFor.set(corr, key);
          events.push({
            at,
            type: "step.started",
            ...(step ? { step } : {}),
            ...(key ? { idempotencyKey: key } : {}),
            detail: { args },
          });
          break;
        }
        case "step_retrying": {
          events.push({
            at,
            type: "step.retrying",
            ...(step ? { step } : {}),
            detail: {
              // The reason for THIS retry, which is what the brief asks for.
              reason: data["error"],
              retryAfter: data["retryAfter"],
            },
          });
          break;
        }
        case "step_completed": {
          const duration = elapsed(startedAt.get(corr), at);
          events.push({
            at,
            type: "step.succeeded",
            ...(step ? { step } : {}),
            ...(keyFor.get(corr) ? { idempotencyKey: keyFor.get(corr)! } : {}),
            ...(duration !== undefined ? { durationMs: duration } : {}),
            detail: { result: data["result"] },
          });
          break;
        }
        case "step_failed": {
          const duration = elapsed(startedAt.get(corr), at);
          events.push({
            at,
            type: "step.failed",
            ...(step ? { step } : {}),
            ...(keyFor.get(corr) ? { idempotencyKey: keyFor.get(corr)! } : {}),
            ...(duration !== undefined ? { durationMs: duration } : {}),
            // Message only. The stack is ten frames of node_modules and would
            // bury the one line that matters.
            detail: { error: data["error"] },
          });
          break;
        }
        case "run_completed": {
          events.push({
            at,
            type: "booking.settled",
            detail: { outcome: data["output"] },
          });
          break;
        }
        // run_started and step_started are deliberately dropped: the first
        // always follows run_created, and the second adds a line per attempt
        // without adding information the retry and outcome events lack.
        default:
          break;
      }
    }
  }

  return {
    booking: {
      id: booking.id,
      state: booking.state,
      requiresIntervention: requiresIntervention(booking.state),
      idempotencyKey: booking.idempotencyKey,
      fingerprint: booking.fingerprint,
      offerId: booking.offerId,
      amountCents: booking.amountCents,
      currency: booking.currency,
      ...(booking.reason ? { reason: booking.reason } : {}),
      ...(booking.holdId ? { holdId: booking.holdId } : {}),
      ...(booking.chargeId ? { chargeId: booking.chargeId } : {}),
      ...(booking.holdReleased !== undefined ? { holdReleased: booking.holdReleased } : {}),
      createdAt: booking.createdAt,
      updatedAt: booking.updatedAt,
    },
    ...(booking.runId ? { runId: booking.runId } : {}),
    events,
  };
}
