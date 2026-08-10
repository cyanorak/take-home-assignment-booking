/**
 * TEMPORARY — V1 toolchain probe. Delete once the walking skeleton lands.
 *
 * Every WDK behaviour in PLAN.md came from documentation; none of it had been
 * run. This file exists to answer the five open questions from PLAN.md §13
 * before any booking logic is built on top of them:
 *
 *   1. Does the Vitest plugin compose with our setup at all?
 *   2. Can a step see request-scoped state? (A18)
 *   3. Do module-level singletons survive the step boundary?
 *   4. Does getRun(runId).returnValue work from outside the starting call?
 *   5. Is world.runs.list() reachable from a test process? (M7's evidence)
 */

// Module-level state. If steps run in a separate module instance or process,
// the step will not see writes made here by the HTTP handler, and will not be
// able to accumulate state the test can read back.
export const probeState = {
  /** Written by the HTTP handler before start(). Tests A18. */
  requestMarker: null as string | null,
  /** Incremented inside the step. Tests singleton survival across the boundary. */
  stepInvocations: 0,
};

export function resetProbeState(): void {
  probeState.requestMarker = null;
  probeState.stepInvocations = 0;
}

export type ProbeResult = {
  echoed: string;
  /** What the step could see of module state written outside the workflow. */
  markerVisibleInStep: string | null;
  invocationsSeenByStep: number;
};

export async function probeWorkflow(echoed: string): Promise<ProbeResult> {
  "use workflow";
  return await probeStep(echoed);
}

export async function probeStep(echoed: string): Promise<ProbeResult> {
  "use step";
  probeState.stepInvocations += 1;
  return {
    echoed,
    markerVisibleInStep: probeState.requestMarker,
    invocationsSeenByStep: probeState.stepInvocations,
  };
}
