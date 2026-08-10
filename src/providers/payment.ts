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
import {
  nextOutcome,
  ProviderPermanentError,
  ProviderTransientError,
  type Outcome,
} from "./chaos.js";

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
    script?: Outcome[],
  ): Promise<Charge> {
    // Read-repair FIRST, before the script is consulted. A retry with the same
    // key must never produce a second charge — this is I1, and it is the whole
    // reason the key exists. It is also what makes `applied_then_lost`
    // survivable: the committed charge is found before anything can fail again.
    const existingId = chargeIdByKey.get(idempotencyKey);
    if (existingId) return { ...chargesById.get(existingId)! };

    const outcome = nextOutcome(`charge:${idempotencyKey}`, script);
    if (outcome === "http_5xx") throw new ProviderTransientError("payment 503");
    if (outcome === "timeout") throw new ProviderTransientError("payment timeout");
    if (outcome === "permanent") throw new ProviderPermanentError("card declined");

    const charge: Charge = {
      chargeId: `ch_${crypto.randomUUID()}`,
      amountCents,
      currency,
      // `pending` is the one failure mode no idempotency scheme can resolve:
      // retrying faithfully returns `pending` again, because the information
      // does not exist yet at the provider (CORRECTNESS.md §3.3b).
      status: outcome === "pending" ? "pending" : "succeeded",
      idempotencyKey,
    };
    chargesById.set(charge.chargeId, charge);
    chargeIdByKey.set(idempotencyKey, charge.chargeId);

    if (outcome === "applied_then_lost") {
      throw new ProviderTransientError("payment response lost after commit");
    }
    return { ...charge };
  },

  async refund(chargeId: string, script?: Outcome[]): Promise<void> {
    const charge = chargesById.get(chargeId);
    if (!charge) throw new UnknownChargeError(chargeId);
    if (refunded.has(chargeId)) return; // already done — no-op

    const outcome = nextOutcome(`refund:${chargeId}`, script);
    if (outcome === "http_5xx") throw new ProviderTransientError("payment 503");
    if (outcome === "timeout") throw new ProviderTransientError("payment timeout");
    if (outcome === "permanent") throw new ProviderPermanentError("refund rejected");

    refunded.add(chargeId);
    if (outcome === "applied_then_lost") {
      throw new ProviderTransientError("payment response lost after commit");
    }
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
