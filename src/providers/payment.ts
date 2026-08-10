/**
 * Mock PaymentProvider. Same design notes as inventory.ts.
 *
 * `charge()` CREATES — the same amount can legitimately be charged twice, so
 * only an idempotency key can distinguish a retry from a second charge. This is
 * the call that I1 protects, and the one `applied_then_lost` attacks (V3).
 *
 * `refund()` TRANSITIONS a named charge, so the chargeId is the key.
 */
import type { Charge, PaymentProvider } from "../domain/types.js";

const chargesById = new Map<string, Charge>();
const chargeIdByKey = new Map<string, string>();
const refunded = new Set<string>();

export class UnknownChargeError extends Error {
  constructor(chargeId: string) {
    super(`unknown charge: ${chargeId}`);
    this.name = "UnknownChargeError";
  }
}

export const paymentProvider: PaymentProvider = {
  async charge(
    amountCents: number,
    currency: string,
    idempotencyKey: string,
  ): Promise<Charge> {
    // Read-repair. A retry with the same key must never produce a second
    // charge — this is I1, and it is the whole reason the key exists.
    const existingId = chargeIdByKey.get(idempotencyKey);
    if (existingId) return { ...chargesById.get(existingId)! };

    const charge: Charge = {
      chargeId: `ch_${crypto.randomUUID()}`,
      amountCents,
      currency,
      status: "succeeded",
      idempotencyKey,
    };
    chargesById.set(charge.chargeId, charge);
    chargeIdByKey.set(idempotencyKey, charge.chargeId);
    return { ...charge };
  },

  async refund(chargeId: string): Promise<void> {
    const charge = chargesById.get(chargeId);
    if (!charge) throw new UnknownChargeError(chargeId);
    if (refunded.has(chargeId)) return; // already done — no-op
    refunded.add(chargeId);
  },
};

/** Provider's own view — only readable from inside a step. */
export function inspectCharge(chargeId: string): Charge | undefined {
  const charge = chargesById.get(chargeId);
  return charge ? { ...charge } : undefined;
}

export function countCharges(): number {
  return chargesById.size;
}
