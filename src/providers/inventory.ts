/**
 * Mock InventoryProvider.
 *
 * State lives in module-level Maps. Verified safe by the V1 probe: all step
 * routes share one module instance, so a hold created by `holdStep` is visible
 * to `consumeStep` and `releaseStep`. It is NOT visible to the HTTP handler —
 * every provider access must therefore happen inside a step (PLAN.md §11.1).
 *
 * Idempotency follows the shape of the given contract (PLAN.md A16):
 *   - `hold()` CREATES, so it takes an idempotency key.
 *   - `release()` / `consume()` TRANSITION a named resource, so the holdId is
 *     the key. A repeat call on an already-transitioned hold is a no-op
 *     returning success; an illegal transition is a genuine error.
 */
import type { Hold, InventoryProvider } from "../domain/types.js";

const HOLD_TTL_MS = 15 * 60 * 1000;

const holdsById = new Map<string, Hold>();
const holdIdByKey = new Map<string, string>();

export class UnknownHoldError extends Error {
  constructor(holdId: string) {
    super(`unknown hold: ${holdId}`);
    this.name = "UnknownHoldError";
  }
}

export class IllegalHoldTransitionError extends Error {
  constructor(holdId: string, from: string, to: string) {
    super(`hold ${holdId} cannot go from ${from} to ${to}`);
    this.name = "IllegalHoldTransitionError";
  }
}

export const inventoryProvider: InventoryProvider = {
  async hold(offerId: string, idempotencyKey: string): Promise<Hold> {
    // Read-repair: the same key always yields the same hold, so a retry after
    // an unknown outcome returns the original rather than creating a second.
    const existingId = holdIdByKey.get(idempotencyKey);
    if (existingId) return { ...holdsById.get(existingId)! };

    const hold: Hold = {
      holdId: `hold_${crypto.randomUUID()}`,
      offerId,
      status: "held",
      expiresAt: new Date(Date.now() + HOLD_TTL_MS).toISOString(),
    };
    holdsById.set(hold.holdId, hold);
    holdIdByKey.set(idempotencyKey, hold.holdId);
    return { ...hold };
  },

  async release(holdId: string): Promise<void> {
    const hold = holdsById.get(holdId);
    if (!hold) throw new UnknownHoldError(holdId);
    if (hold.status === "released") return; // already done — no-op
    if (hold.status === "consumed") {
      throw new IllegalHoldTransitionError(holdId, "consumed", "released");
    }
    hold.status = "released";
  },

  async consume(holdId: string): Promise<void> {
    const hold = holdsById.get(holdId);
    if (!hold) throw new UnknownHoldError(holdId);
    if (hold.status === "consumed") return; // already done — no-op
    if (hold.status === "released") {
      throw new IllegalHoldTransitionError(holdId, "released", "consumed");
    }
    hold.status = "consumed";
  },
};

/** Provider's own view — only readable from inside a step. */
export function inspectHold(holdId: string): Hold | undefined {
  const hold = holdsById.get(holdId);
  return hold ? { ...hold } : undefined;
}

export function countHolds(): number {
  return holdsById.size;
}
