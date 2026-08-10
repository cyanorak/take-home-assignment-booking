# Booking Service

A small booking service that holds inventory through one mock provider, charges through
another, and returns a typed response — built on a durable workflow runtime, with an audit
timeline that explains what happened to any booking.

> **Status: in progress.** The happy path, idempotency, and the provider failure modes work
> (V1–V3). The full state machine and the timeline are not built yet — see
> [Build progress](#build-progress) for exactly what does and does not work.

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

```bash
curl -X POST http://localhost:3000/bookings \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-1' \
  -d '{"offerId":"offer-abc","amountCents":12500,"currency":"GBP"}'
```

```jsonc
// 201
{
  "bookingId": "bkg_6fbb3945-...",
  "state": "confirmed",
  "requiresIntervention": false,
  "holdId": "hold_6d44f069-...",
  "chargeId": "ch_a21da0ee-..."
}
```

```bash
npm test             # unit + integration
npm run test:unit
npm run test:integration

./scripts/smoke.sh   # against a running server — see below
```

Requires Node ≥ 22. No Docker, no database, no cloud account.

### Why there is a smoke script as well as a test suite

The integration tests drive the Hono app through `app.request()`, which **bypasses Nitro
entirely**. During V1 that let 12 green tests coexist with a server that returned `500` to
every request, because `nitro.config.ts` had the wrong handler format. The suite
structurally cannot catch that class of bug.

`scripts/smoke.sh` runs against a real server over real HTTP — including four concurrent
requests sharing one `Idempotency-Key` — and doubles as the curl walkthrough. Run it after
any change to the server wiring:

```bash
npm run dev            # terminal 1
./scripts/smoke.sh     # terminal 2
```

## Driving the failure modes — the `X-Chaos` header

Both providers fail on demand, configured by **one mechanism**: an ordered list of outcomes
per provider method. The Nth call to a method gets the Nth outcome, and once the list runs
out everything succeeds. Fully deterministic — no randomness, no timing, no sleeps.

```
X-Chaos: charge=http_5xx,ok        # fail once, then succeed
X-Chaos: hold=applied_then_lost    # commit, then lose the response
X-Chaos: charge=permanent          # declined — not retried
X-Chaos: hold=timeout;charge=http_5xx,ok    # ';' separates methods
```

| Outcome | What the provider does |
|---|---|
| `ok` | Succeeds |
| `http_5xx` | Throws. **Nothing committed** — safe to retry |
| `timeout` | Throws. Nothing committed |
| `applied_then_lost` | **Commits, then throws.** The caller cannot tell this from "never happened" |
| `permanent` | Throws. Sold out / card declined — retrying changes nothing |
| `pending` | Charge only: returns `status: "pending"` |

`applied_then_lost` is the one that matters. It is the failure that idempotency keys exist
for, and it is why the providers read-repair on the key *before* consulting the script:

```bash
curl -X POST http://localhost:3000/bookings \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-lost' \
  -H 'X-Chaos: charge=applied_then_lost' \
  -d '{"offerId":"offer-abc","amountCents":12500,"currency":"GBP"}'
# -> 201 confirmed. The charge was created on attempt 1, the response was lost,
#    and attempt 2 returned that same charge rather than making a second one.
```

Inspect what actually happened:

```bash
npx workflow inspect runs          # find the run
npx workflow inspect run <run-id>  # per-step attempts, inputs, outputs
```

### How the tests use it

Two layers, deliberately:

- **Unit tests** (`tests/chaos.test.ts`) call the providers directly, with no workflow
  runtime. Provider state is observable from the test process here, so this is where
  "exactly one charge exists" is asserted *directly* — `countCharges()` before and after.
- **Integration tests** (`tests/failure-modes.integration.test.ts`) drive the header through
  a real booking. Provider state is *not* readable from the test process (steps run in a
  separate module instance), so these assert through the runtime's own step log: how many
  attempts ran, and which idempotency key the persisted input carries.

Neither layer alone would be convincing. Together they say: the key never varies across
attempts, and a provider given the same key twice charges once.

The script reaches the provider as a **workflow argument**, never as ambient request state —
steps cannot see anything the HTTP handler set, so a header read ambiently inside a step
would silently do nothing.

### Is `X-Chaos` safe to deploy?

**It is off in production by default** (`NODE_ENV === "production"`), and can be turned back
on for a demo deployment with `ALLOW_CHAOS=true`.

The header is caller-controlled, and two outcomes are not merely self-harm:
`charge=pending` produces a booking with `requiresIntervention: true`, so any caller could
manufacture pages for the on-call engineer; and `hold=timeout,timeout,timeout` amplifies one
request into several provider calls, against a real provider's rate limit and bill.

The assignment assumes a single trusted upstream caller, which is what makes the header
acceptable here — but that is an assumption worth stating rather than relying on silently,
so the safe default is inherited rather than remembered. (In a real deployment the mocks
would be Stripe and Amadeus, and the failure-mode argument would have nowhere to go, so this
is defence in depth rather than the only control.)

Responses echo `X-Chaos-Applied` with the script that was actually parsed. Malformed clauses
are ignored rather than rejected, so without the echo "my header did nothing" would be
indistinguishable from "my header was wrong".

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
| V1 | Walking skeleton — happy path end to end | ✅ |
| V2 | Idempotency — claim, replay, conflict, concurrency test | ✅ |
| V3 | Failure modes — retries, `applied_then_lost`, fatal vs retryable | ✅ |
| V4 | State machine — all terminal states, the four quadrants | — |
| V5 | Timeline endpoint | — |
| V6 | Docs — decisions, known gaps, `PROCESS.md` | — |

**Not built yet.** The workflow does not yet catch a permanently-failed step, so a declined
card currently surfaces as a `500` instead of `402 payment_failed`. `confirmed` is still the
only terminal state a caller sees. There is no timeline endpoint. Both land in V4/V5.

### Does the concurrency test prove what it claims?

Verified by mutation, not by assumption. Disabling the claim in `src/store/idempotency.ts`
so every request believes it is the first fails **all six** idempotency tests, including
the run-count assertion. A test that passes with the feature removed proves nothing.

The run count is asserted as a **delta**, never an absolute: workflow data persists in
`.workflow-data/` across test invocations, so an absolute count would depend on history.
Integration test files also run serially (`fileParallelism: false`) — parallel workers
share that directory, and the run-count assertion flaked until they were serialised.

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
  index.ts              Hono app composition
  routes/bookings.ts    POST /bookings — validate, start, await, persist, respond
  workflows/booking.ts  the workflow and its steps, each annotated with what a
                        retry of it does in the world
  providers/
    inventory.ts        mock InventoryProvider
    payment.ts          mock PaymentProvider
    chaos.ts            failure-mode script + X-Chaos parsing
  domain/
    types.ts            provider contracts and the booking state machine
    keys.ts             L2 idempotency key derivation (frozen by unit test)
    request.ts          validation and request fingerprinting
  store/
    bookings.ts         in-memory booking store (handler-side only)
    idempotency.ts      L1 — the atomic claim; the whole of M7 rests on it
scripts/smoke.sh        end-to-end checks against a running server
tests/
  *.test.ts             unit tests — no workflow runtime, fast
  *.integration.test.ts integration tests — in-process Local World, no server
nitro.config.ts         build config; loads workflow/nitro to compile directives
```

**Why `src/store` is handler-side only.** Steps execute in a separate module instance from
the HTTP handler — verified by probe during V1, writes cross in neither direction. So steps
are pure provider wrappers, the workflow *returns* its outcome, and the handler persists it.
Provider state is the mirror image: it lives in module-level maps that all step routes
share, and is therefore only reachable from inside a step.

## Observability

```bash
npx workflow inspect runs        # list workflow runs
npx workflow inspect run <id>    # one run in detail
npx workflow web                 # web UI
```

The timeline endpoint returns the `runId`, so any booking can be cross-referenced against
the runtime's own view.
