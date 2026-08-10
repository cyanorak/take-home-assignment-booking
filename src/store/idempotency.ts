/**
 * L1 — the idempotency claim. CORRECTNESS.md §3/L1.
 *
 * A unique constraint, not a lock: the record is never leased, never expires as
 * part of the correctness path, and is never released on completion. It must
 * outlive the run, because replay (I5) has to work long after the booking
 * finished.
 *
 * The atomicity argument is one line: `claim()` contains no `await` between
 * reading the map and writing it, so nothing can interleave. That is true
 * because there is exactly one process — a deliberate, documented choice
 * (PLAN.md §1.1), not an accident. A multi-instance deployment would replace
 * this single function with one conditional write (`SET NX`); the shape of the
 * interface is already that of a single round trip, with no get-then-set.
 */

export type ClaimOutcome<T> =
  /** This request owns the key. It must set `record.inflight` immediately. */
  | { outcome: "claimed"; record: IdempotencyRecord<T> }
  /** A duplicate of an in-flight or completed request. Join it. */
  | { outcome: "exists"; record: IdempotencyRecord<T> }
  /** Same key, different request. Never replay — that would answer a question
   *  the caller never asked (PLAN.md A3). */
  | { outcome: "conflict"; record: IdempotencyRecord<T> };

export type IdempotencyRecord<T> = {
  key: string;
  fingerprint: string;
  bookingId?: string;
  runId?: string;
  /**
   * Set synchronously by the winner, in the same turn as the claim. Because
   * calling an async function returns its promise immediately, there is no
   * window in which a record is claimed but has nothing to await — which is
   * what lets both concurrent requests return byte-identical responses.
   */
  inflight?: Promise<T>;
  /** Cached terminal result, so replay works after the run has finished. */
  result?: T;
};

const records = new Map<string, IdempotencyRecord<unknown>>();

export function claim<T>(key: string, fingerprint: string): ClaimOutcome<T> {
  // --- begin atomic section: no `await` may appear between here and the set ---
  const existing = records.get(key) as IdempotencyRecord<T> | undefined;
  if (existing) {
    return existing.fingerprint === fingerprint
      ? { outcome: "exists", record: existing }
      : { outcome: "conflict", record: existing };
  }
  const record: IdempotencyRecord<T> = { key, fingerprint };
  records.set(key, record as IdempotencyRecord<unknown>);
  // --- end atomic section ---
  return { outcome: "claimed", record };
}

/** Caches the terminal result for replay. */
export function settle<T>(record: IdempotencyRecord<T>, result: T): void {
  record.result = result;
}

export function countClaims(): number {
  return records.size;
}
