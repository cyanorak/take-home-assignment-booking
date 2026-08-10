/**
 * Provider failure-mode configuration — PLAN.md A9.
 *
 * One mechanism: an ordered list of outcomes per provider method. The Nth call
 * to a method gets the Nth outcome, defaulting to `ok` once the list runs out.
 * Fully deterministic — no clocks, no randomness, no sleeps. Probabilistic
 * failure rates were rejected: a flaky test is worse than no test, and "1 in 10
 * requests fails" cannot demonstrate a specific quadrant on demand.
 *
 * The script reaches the provider as a *workflow argument*, never as ambient
 * request state. Steps execute in a separate module instance and cannot see
 * anything the HTTP handler set (verified in V1, PLAN.md A18) — a script read
 * ambiently would silently do nothing.
 */

export type Outcome =
  /** Normal success. */
  | "ok"
  /** Transient server error. Nothing committed; safe to retry. */
  | "http_5xx"
  /** Network-shaped failure. Nothing committed. */
  | "timeout"
  /**
   * The important one (PLAN.md A10). The provider COMMITS its state change and
   * *then* the call fails, so the caller cannot distinguish it from "never
   * happened". Only an idempotency key can resolve it — the retry must return
   * the original record rather than acting again.
   */
  | "applied_then_lost"
  /** Permanent refusal — sold out, card declined. Retrying changes nothing. */
  | "permanent"
  /** Payment only: the charge is neither captured nor released (A17). */
  | "pending";

const OUTCOMES: readonly Outcome[] = [
  "ok",
  "http_5xx",
  "timeout",
  "applied_then_lost",
  "permanent",
  "pending",
];

export type ProviderMethod = "hold" | "charge" | "consume" | "release";

const METHODS: readonly ProviderMethod[] = ["hold", "charge", "consume", "release"];

/** Serializable, because it travels as a workflow argument. */
export type ChaosScript = Partial<Record<ProviderMethod, Outcome[]>>;

/**
 * Is caller-driven failure injection allowed in this environment?
 *
 * `X-Chaos` is a debugging and demo affordance, but it is caller-controlled and
 * two of its outcomes are not merely self-harm:
 *
 *   - `charge=pending` produces a booking with requiresIntervention: true, so
 *     any caller could manufacture pages for the on-call engineer at will.
 *   - `hold=timeout,timeout,timeout` turns one request into four provider
 *     calls, against a real provider's rate limit and bill.
 *
 * The assignment assumes a single trusted upstream caller, which is what makes
 * the header acceptable here. That assumption is stated rather than relied on
 * silently: chaos is **off in production** unless explicitly re-enabled, so a
 * deployment inherits the safe default without anyone having to remember.
 *
 * (In a real deployment the mocks would be replaced by Stripe and Amadeus, and
 * the `script` argument would have nowhere to go — so this is defence in depth
 * rather than the only thing standing between a caller and the failure modes.)
 */
export function chaosAllowed(): boolean {
  if (process.env.ALLOW_CHAOS === "true") return true; // opt-in for a demo deploy
  return process.env.NODE_ENV !== "production";
}

/**
 * Parses `X-Chaos: charge=applied_then_lost,ok;hold=http_5xx`.
 *
 * `;` separates methods, `=` separates a method from its outcome list, `,`
 * separates sequential outcomes. Unknown methods and outcomes are ignored
 * rather than rejected: this is a test and demo affordance, and failing a
 * booking because a debugging header was malformed would be worse than
 * ignoring it.
 *
 * Returns an empty script — i.e. everything succeeds — when chaos is not
 * allowed in this environment.
 */
export function parseChaosHeader(
  header: string | undefined,
  allowed: boolean = chaosAllowed(),
): ChaosScript {
  if (!header || !allowed) return {};
  const script: ChaosScript = {};

  for (const clause of header.split(";")) {
    const [rawMethod, rawOutcomes] = clause.split("=");
    const method = rawMethod?.trim() as ProviderMethod | undefined;
    if (!method || !METHODS.includes(method) || !rawOutcomes) continue;

    const outcomes = rawOutcomes
      .split(",")
      .map((o) => o.trim())
      .filter((o): o is Outcome => OUTCOMES.includes(o as Outcome));

    if (outcomes.length > 0) script[method] = outcomes;
  }
  return script;
}

/**
 * Per-resource call counters, so a script advances across retries.
 *
 * Keyed by the same value that identifies the operation to the provider — the
 * idempotency key for creates, the resource id for transitions. That is what
 * makes `http_5xx,ok` mean "fail once, then succeed" rather than looping
 * forever: the count survives the retry, because the counter lives with the
 * provider rather than with the attempt.
 */
const callCounts = new Map<string, number>();

export function nextOutcome(counterKey: string, script: Outcome[] | undefined): Outcome {
  const n = callCounts.get(counterKey) ?? 0;
  callCounts.set(counterKey, n + 1);
  return script?.[n] ?? "ok";
}

/** Errors a mock provider raises. Steps map these to WDK retry semantics. */
export class ProviderTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderTransientError";
  }
}

export class ProviderPermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderPermanentError";
  }
}
