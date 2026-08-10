/**
 * TEMPORARY — V1 provider-boundary probe. Delete with src/probe.ts.
 *
 * Q3 established that steps do not share a module instance with the *caller*.
 * That does not tell us whether the four provider-touching steps share one
 * instance with *each other*. Steps compile into isolated routes, so it is
 * entirely possible that holdStep and consumeStep hold different copies of the
 * provider store — in which case a mock provider backed by a module-level Map
 * cannot work at all, and the whole failure matrix is unbuildable as planned.
 *
 * This probe assumes nothing. Every step reports MODULE_INSTANCE_ID, so a
 * failure says *which* boundary broke rather than merely that one did.
 *
 * Verifies:
 *   P1  holdStep creates a hold
 *   P2  consumeStep can read and consume that exact hold
 *   P3  releaseStep can read a hold created by holdStep
 *   P4  a retried step sees the provider's prior idempotency record
 *   P5  charge state survives between separate charge-step invocations
 */
import { getStepMetadata, RetryableError } from "workflow";

/** Unique per module *instance*. Differing values prove separate instances. */
export const MODULE_INSTANCE_ID = crypto.randomUUID().slice(0, 8);

type Hold = {
  holdId: string;
  offerId: string;
  status: "held" | "released" | "consumed";
};

type Charge = {
  chargeId: string;
  amountCents: number;
  status: "succeeded";
  idempotencyKey: string;
};

// Module-level provider state — exactly what the real mocks would use.
const holds = new Map<string, Hold>();
const holdsByKey = new Map<string, string>();
const charges = new Map<string, Charge>();
const chargesByKey = new Map<string, string>();

/** Observations returned by every step, so the test can see the boundary. */
type Probe = {
  instanceId: string;
  holdsInStore: number;
  chargesInStore: number;
};

function probe(): Probe {
  return {
    instanceId: MODULE_INSTANCE_ID,
    holdsInStore: holds.size,
    chargesInStore: charges.size,
  };
}

export type HoldObservation = Probe & { hold: Hold; reusedExisting: boolean };
export type HoldViewObservation = Probe & {
  found: boolean;
  statusSeen: Hold["status"] | null;
};
export type ChargeObservation = Probe & {
  charge: Charge;
  reusedExisting: boolean;
  attempt: number;
};

export async function probeHoldStep(
  offerId: string,
  idemKey: string,
): Promise<HoldObservation> {
  "use step";
  const existingId = holdsByKey.get(idemKey);
  if (existingId) {
    const existing = holds.get(existingId)!;
    return { ...probe(), hold: existing, reusedExisting: true };
  }
  const hold: Hold = {
    holdId: `hold_${crypto.randomUUID().slice(0, 8)}`,
    offerId,
    status: "held",
  };
  holds.set(hold.holdId, hold);
  holdsByKey.set(idemKey, hold.holdId);
  return { ...probe(), hold, reusedExisting: false };
}

export async function probeConsumeStep(
  holdId: string,
): Promise<HoldViewObservation> {
  "use step";
  const hold = holds.get(holdId);
  if (!hold) return { ...probe(), found: false, statusSeen: null };
  hold.status = "consumed";
  return { ...probe(), found: true, statusSeen: hold.status };
}

export async function probeReleaseStep(
  holdId: string,
): Promise<HoldViewObservation> {
  "use step";
  const hold = holds.get(holdId);
  if (!hold) return { ...probe(), found: false, statusSeen: null };
  hold.status = "released";
  return { ...probe(), found: true, statusSeen: hold.status };
}

export async function probeChargeStep(
  amountCents: number,
  idemKey: string,
): Promise<ChargeObservation> {
  "use step";
  const { attempt } = getStepMetadata();
  const existingId = chargesByKey.get(idemKey);
  if (existingId) {
    const existing = charges.get(existingId)!;
    return { ...probe(), charge: existing, reusedExisting: true, attempt };
  }
  const charge: Charge = {
    chargeId: `ch_${crypto.randomUUID().slice(0, 8)}`,
    amountCents,
    status: "succeeded",
    idempotencyKey: idemKey,
  };
  charges.set(charge.chargeId, charge);
  chargesByKey.set(idemKey, charge.chargeId);
  return { ...probe(), charge, reusedExisting: false, attempt };
}

/**
 * P4 — models `applied_then_lost`: commit the charge, *then* fail. The retry
 * must find the committed record via the same idempotency key rather than
 * charging again. This is the single most important behaviour in the exercise.
 */
export async function probeChargeThenLoseStep(
  amountCents: number,
  idemKey: string,
): Promise<ChargeObservation> {
  "use step";
  const { attempt } = getStepMetadata();
  const existingId = chargesByKey.get(idemKey);
  if (existingId) {
    const existing = charges.get(existingId)!;
    return { ...probe(), charge: existing, reusedExisting: true, attempt };
  }
  const charge: Charge = {
    chargeId: `ch_${crypto.randomUUID().slice(0, 8)}`,
    amountCents,
    status: "succeeded",
    idempotencyKey: idemKey,
  };
  charges.set(charge.chargeId, charge);
  chargesByKey.set(idemKey, charge.chargeId);
  // Committed. Now lose the response, exactly as A10 describes.
  throw new RetryableError("response lost after commit", { retryAfter: 1 });
}

export type ProviderProbeResult = {
  created: HoldObservation;
  consumed: HoldViewObservation;
  secondHold: HoldObservation;
  released: HoldViewObservation;
  firstCharge: ChargeObservation;
  secondCharge: ChargeObservation;
  recoveredCharge: ChargeObservation;
};

export async function providerProbeWorkflow(
  runKey: string,
): Promise<ProviderProbeResult> {
  "use workflow";

  // P1/P2 — create a hold, then consume that exact hold from a different step.
  const created = await probeHoldStep("offer-A", `${runKey}:hold`);
  const consumed = await probeConsumeStep(created.hold.holdId);

  // P3 — a second hold, read by releaseStep (a third distinct step route).
  const secondHold = await probeHoldStep("offer-B", `${runKey}:hold2`);
  const released = await probeReleaseStep(secondHold.hold.holdId);

  // P5 — two separate charge-step invocations sharing one idempotency key.
  const firstCharge = await probeChargeStep(1000, `${runKey}:charge`);
  const secondCharge = await probeChargeStep(1000, `${runKey}:charge`);

  // P4 — commit-then-fail; WDK retries and the retry must find the record.
  const recoveredCharge = await probeChargeThenLoseStep(
    2500,
    `${runKey}:lost`,
  );

  return {
    created,
    consumed,
    secondHold,
    released,
    firstCharge,
    secondCharge,
    recoveredCharge,
  };
}
