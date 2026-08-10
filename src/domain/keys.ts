/**
 * L2 — provider idempotency key derivation. CORRECTNESS.md §3/L2.
 *
 * The single most important rule in this codebase:
 *
 *   The idempotency key must be derived from the identity of the thing in the
 *   world, never from the identity of the execution attempting it.
 *
 * That is why this function takes a `bookingId` and a literal step name, and
 * has no access to workflow or step metadata. WDK's own docs suggest using
 * `getStepMetadata().stepId` for external-API idempotency keys. We deliberately
 * do not — `stepId` is stable across retries *within* a run but differs
 * *between* runs, and every scenario where L2 is load-bearing is one where two
 * runs might exist. See PLAN.md D1.1/C2.1.
 *
 * Frozen against a unit test, so a future change that reintroduces execution
 * context fails a test rather than a customer.
 */

/** Only the two *creating* provider calls take keys — PLAN.md A16. */
export type KeyedOperation = "hold" | "charge";

export function providerIdempotencyKey(
  bookingId: string,
  operation: KeyedOperation,
): string {
  return `bkg:${bookingId}:${operation}`;
}
