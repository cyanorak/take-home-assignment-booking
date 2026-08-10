/**
 * Request validation and fingerprinting.
 *
 * Validation runs BEFORE the idempotency claim (PLAN.md §11.5): a malformed
 * body must not burn a key, or a client that fixes its payload and retries with
 * the same key would get a permanent conflict for a booking that never existed.
 */
import { createHash } from "node:crypto";
import type { BookingRequest } from "./types.js";

export type ValidationError = { code: string; message: string };

export function validateBookingRequest(
  body: unknown,
): { ok: true; value: BookingRequest } | { ok: false; error: ValidationError } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: { code: "invalid_body", message: "body must be a JSON object" } };
  }

  const { offerId, amountCents, currency } = body as Record<string, unknown>;

  if (typeof offerId !== "string" || offerId.length === 0) {
    return { ok: false, error: { code: "invalid_offer_id", message: "offerId must be a non-empty string" } };
  }
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0) {
    return { ok: false, error: { code: "invalid_amount", message: "amountCents must be a positive integer" } };
  }
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    return { ok: false, error: { code: "invalid_currency", message: "currency must be a 3-letter uppercase code" } };
  }

  return { ok: true, value: { offerId, amountCents, currency } };
}

/**
 * Stable hash of the canonicalised request. Two requests sharing an
 * idempotency key are the *same* request only if their fingerprints match —
 * otherwise replaying a stored response would answer a question the caller
 * never asked (PLAN.md A3, invariant I5).
 */
export function fingerprint(request: BookingRequest): string {
  const canonical = JSON.stringify([
    request.offerId,
    request.amountCents,
    request.currency,
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
