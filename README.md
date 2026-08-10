# Booking Service

A small booking service that holds inventory through one mock provider, charges through
another, and returns a typed response — built on a durable workflow runtime, with an audit
timeline that explains what happened to any booking.

> **Status: in progress.** The toolchain and the WDK probe are done (V1 partial). See
> [Build progress](#build-progress) for exactly what does and does not work yet.

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

```bash
npm test             # unit + integration
npm run test:unit
npm run test:integration
```

Requires Node ≥ 22. No Docker, no database, no cloud account.

## Design documents

The reasoning behind this service lives in two documents written before implementation
started. They are the honest record of what was decided and what was deliberately cut.

| Document | Contents |
|---|---|
| [`PLAN.md`](./PLAN.md) | What we build, every decision with its reasoning, 13 explicit cuts, the booking state machine, API contracts, and the build sequence |
| [`CORRECTNESS.md`](./CORRECTNESS.md) | The invariants the service must preserve, the layered idempotency argument, the happy path, the failure taxonomy, and the test matrix |
| `PROCESS.md` | Annotated prompts and reflection — written at the end |

## Architecture at a glance

```
POST /bookings ──> validate ──> claim(Idempotency-Key) ──> start(workflow)
                                       │                        │
                                  (dedupes)              hold ─> charge ─> consume
                                                                  │
GET /bookings/:id/timeline <── project WDK's event log + booking record
```

- **Runtime:** [Workflow Development Kit](https://workflow-sdk.dev) (Vercel), Local World
  in development. The same workflow code deploys to the Vercel World unchanged.
- **HTTP:** Hono, built by Nitro (which compiles the `"use workflow"` / `"use step"`
  directives — Express needs the same, so it is not a Hono-specific cost).
- **Storage:** in-memory. Single process, deliberately — see [Known limitations](#known-limitations).

## Correctness in one page

Idempotency is layered, so that each layer still holds something when the one above it
fails. Full argument in [`CORRECTNESS.md`](./CORRECTNESS.md) §3.

| Layer | Where | Guarantees |
|---|---|---|
| **L1** — atomic claim on `Idempotency-Key` before starting a workflow | API | Exactly one workflow run per key |
| **L2** — provider idempotency keys derived from the *booking*, never the execution | Step | At most one charge and one hold — **independent of L1** |
| **L4** — booking state machine with legal transitions only | Domain | Defines the four-quadrant failure matrix |

The one to keep in view is **L2**. Keys derive from `bookingId`, not from a run id, attempt
number, or `stepId` — so a retry is a *read-repair* of the first attempt rather than a
second one. WDK's own documentation suggests `stepId`; we deliberately do not use it,
because `stepId` differs between runs and every scenario where L2 matters is one where two
runs might exist. See `PLAN.md` D1.1/C2.1.

## Build progress

| | Vertical | Status |
|---|---|---|
| V1 | Walking skeleton — happy path end to end | 🚧 toolchain + probe done |
| V2 | Idempotency — claim, replay, conflict, concurrency test | — |
| V3 | Failure modes — retries, `applied_then_lost`, fatal vs retryable | — |
| V4 | State machine — all terminal states, the four quadrants | — |
| V5 | Timeline endpoint | — |
| V6 | Docs — decisions, known gaps, `PROCESS.md` | — |

## Known limitations

Stated here rather than left for a reader to discover. Fuller list in `CORRECTNESS.md` §4.5.

- **Single process, in-memory.** Bookings and idempotency records do not survive a restart.
  This is deliberate: the brief rules out Postgres and says "no distributed-systems setup
  needed". The one seam that would change is the claim, which is a single conditional write
  (`SET NX`) behind an interface that already has that shape.
- **In-flight runs do not resume after a restart.** That is a property of the WDK *World*,
  not of our code — the Vercel and Postgres Worlds provide it, the Local World does not.
  We name it rather than claim it.
- **No automatic refund.** A booking that ends charged-but-not-booked reports an explicit
  terminal state carrying the `chargeId`, and flags `requiresIntervention`. The refund
  itself is the assignment's own top nice-to-have and is deferred.

## Repository layout

```
src/
  index.ts        Hono app and routes
tests/
  *.test.ts             unit tests (no workflow runtime)
  *.integration.test.ts integration tests (in-process Local World)
nitro.config.ts   build config — loads the workflow module
```

## Observability

```bash
npx workflow inspect runs        # list workflow runs
npx workflow inspect run <id>    # one run in detail
npx workflow web                 # web UI
```

The timeline endpoint returns the `runId`, so any booking can be cross-referenced against
the runtime's own view.
