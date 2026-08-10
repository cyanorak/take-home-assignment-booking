# PLAN.md

Implementation plan for the Booking Service take-home.

This document is the build spec. It should be sufficient to build the project from
scratch without any chat context. It records what we are building, what we decided,
what we deliberately cut, and what we know is missing.

Companion documents:

- `CORRECTNESS.md` — the guarantees the implementation must preserve, the happy path,
  and the full failure taxonomy. Drives the integration test suite.
- `PROCESS.md` — required deliverable: annotated prompts + reflection. Written last.
- `README.md` — required deliverable: clone-to-running in under 5 minutes + decisions.

Status legend used throughout: `DECIDED` / `OPEN` / `CUT`.

---

## 1. The ask, restated

Build a small **Booking Service**: one HTTP endpoint that accepts a booking request,
holds inventory via a mock provider, charges via a second mock provider, and returns a
typed response. Both providers fail in interesting ways on purpose. A second endpoint
exposes an audit timeline so a reviewer — or an on-call engineer at 2am — can see
exactly what happened to any single booking.

The exercise is explicitly not about shipping a polished platform service. It is about
demonstrating correctness reasoning at three boundaries:

1. Between our service and an external provider (partial failure, unknown outcome).
2. Between our workflow and the real world (side effects that cannot be undone by a retry).
3. Between two concurrent requests (idempotency under races).

Time budget is ~2 hours of build. Cutting scope intelligently is part of the grade.

### 1.1 Standing constraint: a single-process service that knows it is one

**Single server, in-memory storage, deliberately.** The assignment scopes this directly —
persistence "beyond what fits in memory or a JSON file" is out, Postgres is "overkill", and
the concurrency requirement is qualified with *"no distributed-systems setup needed"*.
Building for N replicas would be over-building against an explicit instruction.

The discipline is narrow: **depending on single-process execution is fine; depending on it
silently is not.** The assumption gets named in the README, the one seam that would change
is identified (L1, `CORRECTNESS.md` §1.2), and we build nothing for a deployment we are not
making.

Worth keeping in view while simplifying: only L1 was ever deployment-dependent, and it
collapses to a `Map`. **L2 — deterministic provider idempotency keys — was never about
distribution.** Retries within a single run on a single server can duplicate a side effect,
and L2 is what prevents that. It does not get simplified.

### 1.2 The two boundaries that actually carry the grade

Everything below reduces to two hard problems. Worth naming them up front so the design
does not drift away from them:

- **The unknown outcome.** A provider call can fail in a way where we cannot tell
  whether the side effect happened. The provider is the source of truth, we cannot read
  it transactionally, and we must not double-charge. Resolved by: caller-generated
  deterministic idempotency keys, so a retry is a *read-repair* of the first attempt
  rather than a new attempt.
- **The concurrent duplicate.** Two identical requests arrive at the same instant. Only
  one workflow may run. Resolved by: a single atomic claim on the idempotency key at
  the API boundary, before any workflow is created.

## 2. Deliverables checklist (must-have)

These are non-negotiable. Each maps to tests in `CORRECTNESS.md`.

| # | Requirement | Notes |
|---|---|---|
| M1 | `POST /bookings`, idempotent on a client-supplied `Idempotency-Key` header | Header is required; see A2 for missing-header behaviour |
| M2 | A durable workflow orchestrating the booking lifecycle | Runtime choice is ours; see D1 |
| M3 | Two mock providers: `InventoryProvider`, `PaymentProvider` | Shapes given in assignment; we may extend |
| M4 | Providers are idempotent on the keys we pass them | `charge(amt, cur, "key-123")` twice ⇒ one charge |
| M5 | Providers have configurable failure modes | Minimum set: transient 5xx, timeout, **success-but-caller-never-saw-the-response** |
| M6 | Correct handling of the four-quadrant matrix: (charged \| not) × (booked \| not) | Never *silently* leave the customer inconsistent |
| M7 | Idempotency holds under concurrency | Two simultaneous POSTs, same key ⇒ **exactly one workflow run**, proven by asserting a run count |
| M8 | `GET /bookings/:id/timeline` — structured, chronological trace | Steps, provider calls, retries, final state and why |
| M9 | `README.md` — running in under 5 minutes, walks through decisions | |
| M10 | `PROCESS.md` — 5–10 annotated prompts + a half-page reflection | Weighted highest by the reviewers |
| M11 | Full session transcript(s) exported and included | Honest gaps preferred over reconstruction |

Explicitly stated constraint on M8: **do not build a separate audit table just for the
timeline.** It must be derived from artifacts we are already producing. This is a design
constraint, not a suggestion. It is satisfied by projecting WDK's own event/step log
(D1.1/C2) merged with the idempotency and booking records correctness already requires —
we add no storage whose only purpose is audit.

### 2.1 Core — build this, and nothing else, until it all works

Six items. Anything not on this list is deferred by default, including things that feel
obviously worth doing.

1. `POST /bookings` with L1 claim + fingerprint replay/conflict (M1, M7)
2. The two mock providers with scripted failure modes (M3, M4, M5)
3. The workflow: hold → charge → consume, deterministic keys per L2 (M2)
4. The booking state machine — every quadrant of M6 reaching a named terminal state with
   its own typed response arm (M6, §10)
5. `GET /bookings/:id/timeline` (M8)
6. T-conc-1 and the failure-matrix tests; `README.md`; `PROCESS.md` (M7, M9, M10, M11)

### 2.2 Deferred — do not start until §2.1 is complete

| # | Item | Note |
|---|---|---|
| N1 | **Refund** when charged-but-not-booked | The assignment's own top nice-to-have. Core is the explicit terminal state (A4); this is the remedy on top |
| N2 | Webhook/hook resume for a `pending` charge | A17 chose the cheap answer (a named terminal state); this resolves it. Strongest case of the five — `payment_pending` also strands a hold (§10.4) |
| N3 | Provider-side state in the timeline, reconciled against ours | Cheap and high review value, but pure addition |
| N4 | L3 — losing-run convergence via `hook.getConflict()` | Defence-in-depth behind a working L1; the reasoning is the deliverable, the code is optional |
| N5 | Test: L1 disabled, prove L2 holds independently | Best evidence that the layering is real, but it proves a design property rather than a requirement |

### 2.3 Out of scope — from the assignment, do not build

- Authentication, accounts, users. Assume one trusted upstream caller.
- Real third-party APIs. The mock providers are the only sources of truth.
- Any UI. curl and tests are the interface.
- Persistence beyond memory. In-memory `Map` for idempotency and booking state; the
  JSON-file option the assignment permits is a trivial swap we do not build by default.
- Production concerns: deployment, multi-region, rate limiting, secret rotation.
  **No deploy configuration, no Redis/Postgres implementation, no multi-instance tests.**
- Comprehensive test coverage. A handful of targeted failure-mode and concurrency tests.
- A "complete" booking system.

**Note on what "idempotency at each layer" means.** The grading criterion asks how
idempotency was handled "at each layer of the system", and the brief's own framing is
*"at the API layer, the workflow layer, the step layer, or some combination"*. Those are
**our** layers, not distributed ones — so the L1–L4 model (`CORRECTNESS.md` §3) is
answering the question as asked, and it maps onto exactly those layers. It requires no
more than one process.

## 3. What the reviewers said they weigh, in their order

Recorded verbatim in intent, because it should drive where we spend the two hours.

1. **The annotated prompts** — clarity of thought, willingness to push back on the model,
   taste about when to hand-write instead of prompt.
2. **Workflow decomposition** — whether the retry semantics of each step match what that
   step actually does in the world.
3. **Idempotency reasoning** — at each layer, and whether the concurrency test proves
   what it claims.
4. **Audit/timeline design** — would it help someone investigate three weeks later.
5. **Failure mode coverage** — behaviour across the matrix, not the happy path.
6. **API and contract design** — does the typed contract carry the right information out,
   *including in failure cases*.
7. **What we cut and why** — deliberate, not panicked.
8. **README and decision log.**

Implication for budget: the writing is not overhead, it is the deliverable. Roughly
60–70% of effort on code, the rest on `PROCESS.md` / `README.md` / these specs.

Implication for design: item 2 means every step needs an explicit, documented answer to
"what does a retry of this step do in the world?" — that annotation belongs next to the
step in code, not only in prose here.

## 4. Ambiguity register

Each item: the ambiguity, why it matters, and our default resolution. Items marked
`OPEN` need the author's call before implementation. IDs are referenced from
`CORRECTNESS.md`.

### A1 — Is `POST /bookings` synchronous or asynchronous? `DECIDED — (a), fully synchronous`

**Resolution: `POST /bookings` awaits the workflow to a terminal state and returns it.
No deadline, no `202` arm.**

This reverses an intermediate decision (long-poll with a 5s deadline), and the reversal was
driven by counting what each option actually costs.

Fully synchronous **removes**: the deadline constant and its injection, the `202` response
arm, `timelineUrl`, A9's `slow(ms)` script outcome, the T-deadline-1 test, and the three
in-flight states from the HTTP mapping entirely.

It **appears** to cost the duplicate-request race window — a loser finding `claimed` with no
`runId` yet has no `202` to fall back on, and that window is exactly what T-conc-1 hits,
since the winner `await`s `start()`. But the fix is a field on the record, not the second
`Map` and synchronous-ordering rule an earlier draft agonised over:

```ts
const r = claim(key, fingerprint);          // synchronous
if (r.outcome === 'claimed') {
  r.record.inflight = runBooking(...);      // async fn returns its promise immediately
  return await r.record.inflight;           // ...so this lands in the same turn as the claim
}
return await (r.record.inflight ?? r.record.response);   // loser gets the identical result
```

Calling an async function returns its promise synchronously, so there is no window between
claiming and having something to await.

**It also makes the concurrency test stronger.** Under long-poll, T-conc-1's two requests
return *different* responses — one `201 confirmed`, one `202 pending` — because the loser
genuinely did not know yet. Correct, but a weak demonstration of the headline requirement.
Fully synchronous, both return byte-identical responses, which is the assertion M7 is
asking for.

**Accepted limitation, for the README:** a hung provider hangs the request. Nothing hangs
here — providers are scripted and in-memory — but a real deployment needs a deadline and a
`202` path. The timeline endpoint already serves as the polling mechanism, so that is a
small change rather than a redesign. Stating this is cheaper and more honest than building
a deadline we never exercise.

Grading criterion #6 is unaffected: the full typed union still lands on `POST`, since every
terminal state is reachable synchronously.

The original analysis follows, retained because the trade-off is worth showing in
`PROCESS.md`.

---

The assignment says the endpoint "takes a booking request, holds inventory …, charges …,
and returns a typed response", which reads synchronous. But a durable workflow runtime
normally implies "accept, return 202 + id, poll the timeline". These produce materially
different API contracts and different test shapes.

Three viable answers:

- **(a) Fully synchronous.** Await the workflow to a terminal state, return 200/4xx/5xx
  with the outcome. Simplest to demo with curl; but a workflow that is retrying with
  backoff, or waiting on a webhook, blocks the request.
- **(b) Fully asynchronous.** Always 202 + `bookingId`; the client polls the timeline or
  a status endpoint. Most honest about durability; worse curl demo; needs a status
  endpoint we would otherwise not build.
- **(c) Synchronous with a deadline (default recommendation).** Await the workflow up to
  a bounded wall-clock deadline (~2s). If terminal, return the terminal typed response.
  If not, return `202` with `status: "pending"` and the `bookingId`, and let the workflow
  continue in the background. The typed response models `pending` as a first-class
  outcome rather than a timeout.

(c) demonstrates the most correctness thinking: it forces the response contract to admit
"I do not yet know", which is the honest answer in a distributed system, and it keeps the
curl demo pleasant. Cost: the response union has one more arm and the tests must handle
a non-deterministic arm — mitigated by making provider latency/failure deterministic in
tests (see A9).

Runtime note: WDK makes all three cheap. `start()` returns immediately with a `runId`
(option b), and `run.returnValue` is an awaitable that blocks until the workflow
completes, so (c) is `Promise.race([run.returnValue, deadline])` and (a) is awaiting
`returnValue` outright. The choice is therefore a pure API-design decision, not a
technical constraint.

### A2 — What if `Idempotency-Key` is missing or malformed? `DECIDED`

The header is client-supplied and the whole correctness story hangs off it. Generating
one server-side would silently disable idempotency for a careless caller — the exact
2am bug class this exercise is about.

**Resolution:** the header is **required**. Missing or empty ⇒ `400` with a typed error.

*Cut: format validation* (length bounds, printable-ASCII checks). There is no untrusted
caller here — the assignment says to assume one trusted upstream — and the key only ever
becomes a `Map` key. Input-hardening for a threat model the exercise excludes.

### A3 — Same key, different request body: replay or reject? `DECIDED`

Stripe's semantics, and the safe ones: an idempotency key identifies *one specific
request*, not "the most recent request from this caller". Replaying a stored response
for a body the caller never sent is a silent wrong answer.

**Resolution:** store a **request fingerprint** (stable hash of the canonicalised body)
alongside the key. Same key + same fingerprint ⇒ replay the stored response (or join the
in-flight run). Same key + different fingerprint ⇒ `409 Conflict`, typed
`idempotency_key_reuse`. The assignment nudges at this by naming "the original request
fingerprint" as a timeline entry, which suggests they expect us to have one.

### A4 — Does the four-quadrant matrix require *automatic* compensation? `DECIDED — no`

M6 says the service "must never *silently* leave a customer in an inconsistent state".
The word "silently" admits two readings:

- **Weak:** it is acceptable to end in `payment_succeeded, inventory_failed` provided the
  state is explicit, typed, surfaced in the response, and visible in the timeline as
  needing action.
- **Strong:** actively compensate — refund the charge, release the hold — falling back to
  an explicit "needs human" state only when compensation itself fails.

**Resolution: the weak reading is core. Refund is deferred to §2.2/N1.**

An earlier draft of this plan promoted refund to must-have. That was wrong, and it is worth
recording *why* it was wrong, because it is the exact error the assignment warns about:
**"Refund flow when payment succeeded but inventory failed permanently" is listed verbatim
under "Nice to have (only if you have time)."** Promoting it was over-scoping against an
explicit instruction, on the reasoning that the quadrant "feels" like the heart of the
exercise. The brief already told us where it sits.

The weak reading genuinely satisfies M6. Ending in a terminal `charged_not_booked` state
that names the `chargeId`, returns it in a typed response, and shows the whole causal chain
in the timeline is *handling* the quadrant — it is explicit, typed, and actionable. What M6
forbids is silence, not the absence of an automated remedy. A real platform team would
route this to a reconciliation queue rather than auto-refunding anyway.

What this buys: the state machine loses `compensating` and `compensation_failed`, the
workflow loses a saga structure and its rollback steps, and the test matrix loses a branch.
Roughly a third of the remaining build.

**One distinction this must not blur.** "Release the hold when payment fails permanently"
stays **core**; only "refund the charge when inventory fails" is deferred. They are not the
same act:

- Releasing a hold returns *inventory* — no money moves, it is one call, it is the natural
  end of the flow, and without it the not-charged/not-booked quadrant leaves a hold dangling
  until expiry for no reason.
- Refunding returns *money*, which is the remedy the assignment classes as nice-to-have.

Runtime note for whoever picks up N1: WDK documents the saga pattern directly — accumulate
rollback closures as the workflow progresses, run them in reverse on failure, with the
rollbacks declared as steps so they are durable and retried.

### A5 — How does an inconsistent outcome reach the caller? `DECIDED`

The charged-but-not-booked quadrant is a state we *understand*. It must never be flattened
into a bare `500`.

**Resolution:** each inconsistent outcome is its own terminal state with its own typed
response arm, naming the `chargeId` (and `holdId` where relevant) so an on-call engineer
can act without opening the timeline first. `500` is reserved for states we did not
anticipate — which, if the state machine (§10) is complete, should be none of them.

This is the whole of M6 under A4's weak reading, and it is why the state machine matters
more than any compensation machinery would have.

### A6 — What is `:id` in `GET /bookings/:id/timeline`? `DECIDED`

**Resolution:** a server-generated, opaque `bookingId` returned by `POST /bookings`
(including on the idempotent replay, and including on failure responses where a booking
was created). Not the idempotency key: keys are caller-controlled, may be ugly, and
leaking them into URLs conflates "the request that asked" with "the thing that exists".
The timeline may *include* the idempotency key as data. Unknown id ⇒ `404`, typed.

### A7 — Where does the amount come from? `DECIDED`

Two options: the client sends `amountCents` + `currency`, or the server derives price
from `offerId` via an inventory catalogue.

**Resolution:** client supplies `offerId`, `amountCents`, `currency`. Server-side pricing
implies a catalogue and a price-mismatch failure mode we do not have budget to do well,
and the assignment's provider contract already hands the amount to `charge()`. Validate
`amountCents` is a positive integer and `currency` is a 3-letter code. Noted in README as
a deliberate simplification (a real service would never trust a client-supplied price).

### A8 — Does "durable" have to survive process restart? `DECIDED — no, and we say why`

Superseded by the runtime choice. See D1.1/C3: the WDK Local World persists run data to
`.workflow-data/` but queues steps in memory, so interrupted runs do not resume after a
restart. Resumption is a property of the Vercel or Postgres World.

**Resolution:** do not build or claim restart recovery, and do not compensate for its
absence. Local state is in-memory and ephemeral **by design** (D1.1/C3): the dev
expectation is not persistence. Document precisely which property belongs to the runtime,
which to the World, which to our store implementation, and which we are not demonstrating
— see the ownership table in D1.1/C3 and `CORRECTNESS.md` §4.5.

The reason this is safe: I1/I2 (no double charge, no double hold) rest on L2, which
depends on none of it.

### A9 — How are provider failure modes configured? `DECIDED`

The assignment calls this out as a design choice it will read for. Requirements pull in
two directions: tests need *deterministic, per-call* control; a curl demo needs
*ambient* control without recompiling.

**Resolution: one mechanism.** The provider is constructed with an explicit script — an
ordered list of outcomes per method:

| Outcome | Behaviour |
|---|---|
| `ok` | Normal success |
| `http_5xx` | Transient server error — retryable |
| `timeout` | Network-shaped failure, **no** state change at the provider |
| `applied_then_lost` | Commits state, *then* throws (A10) — the important one |
| `pending` | Returns `Charge` with `status: 'pending'` (A17) |

Fully deterministic: no clocks, no randomness, no sleeps. (An earlier draft added a
`slow(ms)` outcome to drive A1's deadline; A1 is now fully synchronous, so nothing in the
suite needs to sleep.)

A request header (`X-Chaos: payment=timeout`) selects a named script for that booking. This
is the *same* mechanism with a second entry point, not a second mechanism — it exists
because the assignment says "curl and tests are how we'll exercise the endpoint", so a
reviewer needs a way in without editing code. Per A18 the selected script must be passed as
a **workflow argument**, since a step cannot see request state.

Rejected: probabilistic failure rates. Flaky tests are worse than no tests, and "1 in 10
requests fails" cannot demonstrate a specific quadrant on demand.

### A10 — What exactly does "success-but-the-caller-never-saw-the-response" mean? `DECIDED`

**Resolution:** the provider **commits its state change** (the charge exists, the hold
exists, an id is allocated) and *then* the call throws a network-shaped error. The caller
has no way to distinguish this from "never happened". This is the single most important
failure mode in the exercise — it is precisely what provider idempotency keys exist for,
and the correct response is a retry with the *same* key returning the *original* record,
not a second side effect. Providers must record the committed state before deciding to
fail, or the mock does not model reality.

### A11 — What does "exactly one workflow run" mean operationally? `DECIDED`

M7 requires demonstrating a run count, so "one workflow ran" must be *observable*, not
inferred from the responses being equal.

**Resolution:** assert against **the framework's own run registry**, not an instrumented
counter of our own. C2 gives us `world.runs.list()`, which is the runtime's authoritative
record of how many runs exist — far stronger evidence than a variable we increment, and
immune to the objection that our counter simply agrees with our own claim logic.

The concurrency test issues `Promise.all([post(k), post(k)])` and asserts all four of:

1. both responses are equivalent (same `bookingId`, same outcome);
2. `(await world.runs.list()).data.filter(r => r.workflowName === 'bookingWorkflow')`
   has length **1** — the runtime's own view;
3. `start()` was invoked exactly once (test-visible counter at our call site) — locates
   the fault in our claim logic rather than the runtime if (2) fails;
4. the providers recorded exactly one hold and one charge (I1/I2 directly).

Asserting only (1) would pass even if two workflows raced and one lost — which is the bug
the test exists to catch. (2) is the assertion WDK's *native* dedup pattern would fail
(D1.1/C1), so it is the one that proves our API-layer claim is doing real work.

Note a discarded earlier idea: incrementing a counter *inside the first step*. Steps
retry, so that counter over-counts on any transient failure and would produce a flaky
test asserting the opposite of what it claims. `world.runs.list()` has no such problem.

### A12 — Which timeline events are worth capturing? `DECIDED` (format settled below)

The assignment is explicit that this is a judgement call and that dumping everything is
the wrong answer: "pick what's actually useful for someone investigating, not everything
that ever happened."

**Proposal — include:** booking created (with request fingerprint + idempotency key);
workflow run started; step started/completed with duration and terminal-vs-retryable
classification; provider call attempts with the idempotency key used, the request summary,
and the response or error *shape*; each retry with its reason and the backoff applied;
final state with the reason it was reached.

**Proposal — exclude:** raw HTTP framing, per-poll noise, successful internal validation
steps, and anything that would be identical on every booking.

**Source is settled and simpler than an earlier draft assumed (D1.1/C2):** the timeline is
a projection of `world.events.list({ runId })` and `world.steps.list({ runId })`, plus the
booking record's own fields (idempotency key, fingerprint, created-at, current state,
terminal reason). We write **no event log of our own** — a step's persisted `input`/`output`
already *is* the provider-call record, and the booking record already carries the domain
facts.

**Cut: a service-side event stream.** An earlier draft had us emitting our own events for
things that happen outside a run — replay served, `409` conflict, claim takeover — and
merging two ordered streams with a `source` discriminator to handle the independent clocks.
That is a second audit log wearing a disguise, which is what M8 explicitly tells us not to
build. A `409` never creates a booking, so it has no timeline to appear in; a replay is
visible from the booking record without an event for it. Dropping it removes the merge, the
ordering problem, and the discriminator field.

**Format `DECIDED` — a minimal envelope.** NDJSON's advantages are streaming and volume; a
booking has roughly ten events. The envelope answers "what state is this booking in and
why" in one response, which is the actual 2am question, and it subsumes the status endpoint
cut in A14.

```json
{
  "booking":  { "id", "idempotencyKey", "fingerprint", "state", "reason",
                "holdId", "chargeId", "createdAt", "updatedAt" },
  "runId":    "run_...",
  "events":   [ ... ]
}
```

**Cut: a derived `outcome` summary block.** An earlier sketch grouped state/reason/ids into
a separate top-level object. The booking record already carries every one of those fields —
re-grouping them builds a second representation to construct and keep in sync, for no
information gain. Return the record as it is.

`runId` is included so a reviewer can corroborate against `npx workflow inspect run
<runId>`.

**Cut: redaction.** An earlier draft required redacting payment-instrument data at
projection time. Per A7 the request carries only `offerId`, `amountCents`, and `currency` —
no card data, token, or PII exists in the model. Machinery for a problem we do not have.

### A13 — What is durable-runtime "step" granularity here? `DECIDED — see §11`

D1 has landed, so this is now writable; it lands in §11 (workflow decomposition), which is
grading criterion #2 and therefore not a detail to leave implicit. The rule we will apply:

**A step boundary exists wherever an at-least-once retry would otherwise duplicate a
real-world side effect** — because that is exactly where a durable journal entry, plus a
provider idempotency key, converts at-least-once into effectively-once.

Corollaries that constrain §8, all forced by decisions already made:

- One provider call per step. Two side effects in one step means a retry after a partial
  failure re-runs the first — the classic bug this exercise is built around.
- The idempotency key is a step **argument**, never derived inside (`CORRECTNESS.md` §4.4).
- Compensating actions are steps too, with their own retry policy (A4, A16).
- Pure decisions (validation, choosing whether to compensate) stay in the workflow body,
  which must remain deterministic — no clocks, no randomness, no I/O.
- Every step is annotated in code with what a retry of it does in the world. Grading
  criterion #2 is exactly this question, and the annotation is cheap.

### A14 — Do we need a status endpoint separate from the timeline? `DECIDED`

**Resolution:** no. If A1 lands on (c), `GET /bookings/:id/timeline` returns the current
state alongside the events, which covers polling. A second endpoint is surface area
without new information. Documented as a deliberate cut.

### A15 — Retry budgets, backoff, and time in tests `DECIDED`

Retries plus real sleeps make a test suite slow and flaky. (A1 landed on fully synchronous,
so there is no request deadline to interact with this — one fewer source of timing
coupling.)

**Resolution:** retry policy is per-step data declared next to the step, using WDK's own
vocabulary rather than a homegrown one:

- `stepFn.maxRetries = n` — the attempt budget for that step.
- `FatalError` — thrown for errors that must **not** be retried (validation rejects, a
  provider's permanent decline). This is how a step says "retrying this changes nothing".
- `RetryableError(msg, { retryAfter })` — thrown for transient failures, with the backoff
  the step itself chooses; `getStepMetadata().attempt` gives exponential backoff.

Tests assert on the *sequence and count of attempts*, never elapsed wall-clock time. Keep
`retryAfter` values small in test configuration so the suite stays fast without needing to
fake the framework's internal clock, which we do not control. Every attempt and its
classification is recorded in our timeline (A12).

### A16 — The compensating calls take no idempotency key `DECIDED — leave the interface alone`

**Resolution: do not extend the interface. The given contract is already correct, and the
mocks enforce why.**

An earlier draft of this entry called the unkeyed calls "the single largest hole in the
plan" and proposed adding keys to all three. On closer reading the contract is principled,
and the pattern is consistent:

| Call | Keyed? | Because |
|---|---|---|
| `hold(offerId, key)` | ✅ | **Creates** a resource — no natural id exists yet |
| `charge(amount, currency, key)` | ✅ | **Creates** a resource — the same amount can legitimately be charged twice |
| `release(holdId)` | ❌ | **Transitions** a named resource: `held → released` |
| `consume(holdId)` | ❌ | **Transitions** a named resource: `held → consumed` |
| `refund(chargeId)` | ❌ | **Transitions** a named resource |

Creates need a key because nothing else distinguishes a retry from a second call.
Transitions do not, because the resource id already does: `consume(hold_abc)` twice is not
two consumes, it is one consume attempted twice.

The failure I was worried about resolves cleanly. `applied_then_lost` on consume: the hold
commits to `consumed`, then the call throws; the retry calls `consume(hold_abc)`, finds it
already consumed, returns success. No key needed. Same for a repeated refund.

**What we build instead — each provider resource gets a small state machine**, so the
property we depend on is enforced rather than assumed:

- A repeat call on an already-transitioned resource is a **no-op returning success**.
- An *illegal* transition is a genuine error — `release()` on an already-`consumed` hold
  must fail, not silently succeed.

This is less code than extending the interface, and it is better signal: it shows we
worked out why the contract is shaped the way it is rather than "improving" it.

L2's key derivation therefore covers exactly the two creates, which is the whole story:

```
bkg:${bookingId}:hold     -> inventory.hold
bkg:${bookingId}:charge   -> payment.charge
```

Original analysis retained below for `PROCESS.md`.

---

### A16 (original analysis) — the compensating calls take no idempotency key

Caught by re-reading the assignment's own interfaces. The forward calls take a key; the
compensating and finalising calls do **not**:

```ts
hold(offerId: string, idempotencyKey: string): Promise<Hold>;   // keyed ✅
charge(amountCents, currency, idempotencyKey): Promise<Charge>; // keyed ✅
release(holdId: string): Promise<void>;                         // unkeyed ❗
consume(holdId: string): Promise<void>;                         // unkeyed ❗
refund(chargeId: string): Promise<void>;                        // unkeyed ❗
```

This directly threatens L2, which is the floor of the whole design — and every unkeyed
call is a *retryable step with a real-world side effect*, i.e. precisely the case the
assignment flags under "what to do when a step 'should be' retryable but has a real-world
side effect". Silently ignoring it would be the single largest hole in the plan.

Two defensible answers:

- **(a) Extend the interface** to accept an idempotency key, as the assignment explicitly
  invites ("Extend either interface if it makes the exercise richer"). Uniform with the
  forward path, and L2 applies unchanged.
- **(b) Argue these are naturally idempotent by resource identity.** `release(holdId)` and
  `refund(chargeId)` name a specific resource and are state transitions to a terminal
  state, so a correct provider treats a repeat as a no-op. Real providers largely behave
  this way — Stripe's refund endpoint is keyed, but releasing an already-released hold is
  universally a no-op.

**Leaning (a), with (b) also made true.** Add the key parameter *and* implement the mocks
so repeats are no-ops keyed on resource state. The reasoning: (b) alone rests on the
provider being well-behaved, which is exactly the assumption this exercise punishes. But
(b) is what protects us when a *real* provider ignores our key, so we want both. The
refund path is the one that must not fail — a double refund is a real financial loss and,
unlike a double charge, is not something the customer will report.

Whichever way this lands, the **mock providers must model the unkeyed-repeat case
explicitly**, so a test can prove our behaviour is safe rather than assumed.

### A17 — `Charge.status: 'pending'` is in the given contract `DECIDED — a named terminal state`

**Resolution:** `payment_pending` is a terminal state in §10 that we report honestly and do
not attempt to resolve. Cheap, satisfies I7, and it is the only state in the machine that
would become non-terminal if N2 (webhook resume) were ever built. Analysis retained below.

The assignment's `Charge` type admits `'succeeded' | 'failed' | 'pending'`. Our design so
far treats a charge as binary. A `pending` charge is a genuinely distinct state: the money
is neither captured nor released, the provider will resolve it asynchronously, and *we
cannot know the outcome by retrying* — retrying returns `pending` again.

This matters more than it first looks, because it is the one failure mode where L2 does
not help. A retry with the same key faithfully returns the same `pending` record. There is
no read-repair available; only waiting.

Options:

- **Treat `pending` as terminal-unknown.** Booking rests in an explicit non-terminal state,
  response says so (A1's `pending` arm carries it naturally), timeline shows why. Cheapest,
  honest.
- **Wait for resolution via a hook/webhook** — this is exactly what N2 is for, and it turns
  the nice-to-have into the natural answer for a state the contract already forces on us.
  `createWebhook` + provider callback resumes the run.
- **Poll with `sleep()`** inside the workflow until it resolves or a budget expires. Durable
  and simple; less elegant than a webhook but far cheaper to build.

**Leaning: the first.** Treat `pending` as a named state that the response and timeline
report honestly — cheap, satisfies I7, and it is the *core* answer. N2's webhook resume is
the stretch and only earns its place if §2.1 is finished. Decide alongside D3.

### A18 — Steps are isolated routes, so request-scoped state cannot reach them `DECIDED — build the safe way, verify in V1`

**Resolution:** assume a step sees nothing request-scoped, and build accordingly — chaos
configuration is passed as a **workflow argument**, never read ambiently. That is correct
whether or not the assumption holds, so no verification is needed before writing code.

The dedicated spike is **cut**; V1 (§13) exercises the same questions as a side effect of
shipping the walking skeleton. If V1 shows steps *can* see request state, nothing changes —
we simply did not rely on it. If it shows provider singletons do not survive the step
boundary, that is a stop-and-discuss trigger (§13).

Original analysis below.

---

WDK compiles steps into isolated API routes and dispatches them through a queue. It follows
that a step body **cannot** see request headers, `AsyncLocalStorage` context, or anything
else scoped to the HTTP request that started the run. Everything a step needs must arrive
as workflow input or module-level state.

Two places this bites, both currently under-specified:

1. **A9's `X-Chaos` header.** Per-request failure configuration must be serialised into the
   **workflow arguments**, not read ambiently inside the provider. Otherwise it silently
   does nothing when a step runs out-of-band — a failure mode that would make the demo
   quietly lie.
2. **Mock provider state.** The providers hold in-memory charges and holds that both the
   API layer and the steps must observe. On Local World (single process, in-memory queue)
   a module-level singleton works. That is an assumption about the execution model, not a
   guarantee, and it is exactly the kind of local-only crutch §1.1 warns about. In
   production the provider would be a real HTTP service and the question dissolves.

**Resolution:** pass chaos configuration explicitly as workflow input; keep provider state
in a module singleton with a comment naming it as a stand-in for a remote service; and
**verify both in the D2 spike** before building on them. If steps turn out to run in a
separate process even locally, the provider mock needs a shared store and the plan changes
shape — which is why this is spike-blocking rather than a build-time detail.

## 5. Open decisions for the author

These block implementation and are not ours to assume.

### D1 — Which durable runtime? `DECIDED — Vercel Workflow Development Kit (WDK)`

**Decision: WDK (`npm install workflow`), running against the Local World in development
and test, deployable to the Vercel World unchanged.**

Rationale:

- Setup cost is low, not high. The Local World is bundled, needs no configuration, no
  Docker, and no account; it stores run data as JSON under `.workflow-data/`. Clone-to-run
  stays well inside the 5-minute bar.
- WDK supports plain HTTP frameworks (Express, Fastify, Hono, Nitro, and others) as well
  as Next.js, so we are not forced into a frontend framework for a two-endpoint service.
- Portability is the framework's headline abstraction: the same workflow code runs on the
  Local World, the Vercel World, or a Postgres World, selected by
  `WORKFLOW_TARGET_WORLD`. Local development is therefore not a toy mode — it is the same
  execution model with a different backing store.
- It provides the exact retry vocabulary that grading criterion #2 asks about
  (`maxRetries`, `FatalError`, `RetryableError({ retryAfter })`,
  `getStepMetadata().attempt`), so "do the retry semantics of each step match what that
  step does in the world?" can be answered in code rather than in prose.
- Hooks give us a native, first-class answer to N2 (webhook-resumed workflows).

Rejected alternatives, briefly (expand in `PROCESS.md`):

- **Hand-rolled engine** — we would be asserting durability we built ourselves in two
  hours, which demonstrates less understanding of durable execution than using a real one
  and being precise about its edges.
- **Temporal** — genuinely durable and well understood, but puts a server in the
  reviewer's clone-to-run path.
- **Inngest / Restate** — dev-server dependency, no advantage here over WDK.

### D1.1 — Consequences of choosing WDK (constraints discovered during research)

Four findings materially shape the design. All are documented behaviour, not bugs, and each
is worth naming explicitly in `README.md` / `PROCESS.md`. C1 and C2.1 are cases where we
deliberately depart from the framework's own recommended pattern, with reasons.

**C1 — `start()` accepts no idempotency key, so WDK cannot satisfy M7 on its own.**

`start(workflowFn, args)` returns a `Run` with a generated `runId`. There is no
caller-supplied run id and no keyed/atomic start. WDK's own documented run-idempotency
pattern is *post-hoc*: both concurrent callers may call `start()`, and the losing run
detects the collision inside the workflow body via `hook.getConflict()` and returns early
as a duplicate. The framework's docs state the race plainly: *"Two concurrent requests can
both observe 'no hook yet' and each call `start()`."*

That is a legitimate design (the duplicate does no work), but it does **not** satisfy M7
as written: the assignment requires that two simultaneous POSTs "trigger exactly one
workflow run" and that we *verify the workflow-run count*. Under the native pattern the
count is two.

**Resolution:** idempotency is claimed at the **API layer, before `start()` is called**, via
a single atomic conditional write on the `Idempotency-Key` — a unique constraint, not a
lock. The loser awaits the winner's outcome rather than starting anything. WDK's
hook-conflict pattern is then a second line of defence, which is the role it suits.

Implementation is a `Map`, and Node's event loop is what makes it atomic — **which is a
fine thing to depend on and a bad thing to leave unsaid.** The claim must contain no
`await` between check and insert; that is the whole correctness argument, and it gets a
comment saying so. The seam that would change for more than one server is one line
(`CORRECTNESS.md` §1.2). The full layered argument — including what still holds when this
layer fails — is `CORRECTNESS.md` §3, and that layering is a primary deliverable of the
design, not an implementation detail.

A second reason we cannot lean on hooks for this: hook tokens are only unique *while
active*, and are released when the run completes. Idempotent replay (A3) must work after
the booking has finished, so the idempotency record has to outlive the run regardless.

**C2 — There *is* a full programmatic API for run history. The timeline projects it.**

*(An earlier draft of this plan concluded the opposite, from the `/docs/observability` page
alone, which documents only the CLI and web UI. That was wrong — the API lives under the
World SDK, and the correction materially improved the design.)*

`getWorld()` from `workflow/runtime` exposes four storage sub-interfaces. **Events are the
source of truth; runs, steps, and hooks are materialized views over them.**

| Call | Yields |
|---|---|
| `world.events.list({ runId })` | Full event log — run (5 types), step (5), hook (4), wait (2) |
| `world.events.listByCorrelationId(...)` | Related events **across** runs |
| `world.steps.list({ runId })` | Per-step `status`, `attempt`, `input`, `output`, `error`, `startedAt`, `completedAt`, `retryAfter` |
| `world.runs.get(runId)` | `status`, `input`, `output`, `error`, `startedAt`, `completedAt` |
| `world.hooks.getByToken(token)` | Hook state, for webhook resume (N2) |

Step `input`/`output` are stored devalue-serialized and must be hydrated:

```ts
import { getWorld } from "workflow/runtime";
import { hydrateResourceIO, observabilityRevivers } from "workflow/observability";

const world = await getWorld();                      // await works on both 4.x and 5.x
const steps = await world.steps.list({ runId });
const hydrated = steps.data.map((s) => hydrateResourceIO(s, observabilityRevivers));
```

**Resolution — this is exactly the "artifacts you're already producing" the assignment
points at, and it collapses a chunk of planned work.** Because a step's `input` and
`output` are persisted by the framework, a step whose signature is
`hold(offerId, idempotencyKey) -> Hold` means *"what was sent, what came back, and the
idempotency key used"* is **already recorded** — no bespoke provider-call log needed.
Likewise `attempt` and `retryAfter` give us retry history for free.

The timeline is therefore a **projection over two sources**, which is a real design point
rather than an accident:

1. **WDK's event/step log — execution facts.** Steps, attempts, durations, provider I/O,
   retry reasons, terminal run outcome.
2. **Our own idempotency + booking records — domain facts, and everything that happens
   with no run at all.** A `409` fingerprint conflict, a replayed terminal response, a
   claim takeover (`CORRECTNESS.md` §3.1) — none of these occur inside a workflow, so none
   can come from WDK. Plus the `bookingId → runId` mapping the endpoint needs to resolve
   `:id` at all.

Caveats to carry into the build: the API is explicitly the "low-level" surface (docs steer
casual use toward `getRun()`); `getWorld()` is sync in 4.x and async in 5.x, so always
`await` it; encrypted fields hydrate as raw `Uint8Array`. Pin the major version.

**C2.1 — Do *not* use `stepId` as the provider idempotency key.**

WDK's own docs recommend exactly this, and it is wrong for our requirements:

```ts
const { stepId } = getStepMetadata();
await stripe.charges.create({ ... }, { idempotencyKey: `charge:${stepId}` }); // NOT for us
```

`stepId` is stable across *retries and replays within one run* — which is what makes it a
reasonable default. It is **not** stable *across runs*. Under any circumstance that
produces two runs for one booking (L1 failure, the §3.1 claim takeover, or WDK's own
native dedup pattern which starts two runs by design), two `stepId`s yield two idempotency
keys, and the customer is charged twice.

Our keys derive from **booking identity, not execution identity** — see `CORRECTNESS.md`
§3/L2. This is a deliberate, reasoned departure from the framework's documented guidance
and should be called out in `PROCESS.md`.

**C3 — The Local World does not resume interrupted runs across a restart. This is a
property of the World, not of our design.**

Run data is written to `.workflow-data/`, but the local queue is in-memory: per the docs,
"steps are queued in memory and do not persist across server restarts." Durable resumption
belongs to the Vercel World or the Postgres World.

**Resolution — apply the same dev/production split as §1.1.** Durability is a
*deployment* property selected by `WORKFLOW_TARGET_WORLD`, not something our code
implements or should try to compensate for. In development the expectation is explicitly
**not** persistence: in-memory queue, in-memory stores, ephemeral state, fast tests. In
production the identical workflow code runs on a World that does persist and resume.

What this buys us: we write **zero** recovery code. No journal replay, no boot-time
resume, no restart tests. That work is the runtime's, and reimplementing it locally would
be precisely the hand-rolled durability we rejected in D1 — with the added flaw of testing
a mechanism that never runs in production.

What we owe in exchange is one honest line in the README: **in-flight runs do not survive a
restart, because the Local World queues steps in memory; the Vercel and Postgres Worlds
provide resumption, and switching is an environment variable.** We name the property rather
than claim it.

This costs no correctness. I1/I2 (no double charge, no double hold) rest on L2, which
depends on nothing above it — not the store, not the World, not the process count
(`CORRECTNESS.md` §4.5). So: A8 is closed.

### D2 — HTTP framework and test runner `DECIDED — Hono + Vitest`

TypeScript is given, and WDK requires a framework integration, which rules out bare
`node:http`. Both Hono and Express are supported.

**Hono**, for one concrete reason: `app.request()` drives the app in-process without
binding a port. Every test in this suite is an HTTP test, and the concurrency test issues
two simultaneous requests — doing that against a real socket adds a server lifecycle, port
allocation, and a class of flakiness that has nothing to do with what we are testing.
Express would need `supertest` or a live listener for the same coverage. Reversible in
~20 lines if the spike says otherwise.

**Vitest**, for async ergonomics and concurrent-test control.

**Remaining risk, unchanged:** WDK compiles steps into isolated routes via a bundler
plugin, and its testing story was not documented in the material we could reach. **Spike
this first** — it is the one item that can invalidate design rather than merely cost time.
Questions in §11.

### D3 — Remaining open decisions `NONE`

All author decisions are closed: A1, A4, A8, A12, A16, A17, D1, D2.

A18 remains, but it is **spike-blocking rather than author-blocking** — it is a question
about how WDK behaves, answered by running code (§11), not by a judgement call.

Implementation may begin with the spike.

## 6. Still to be written

- **§10 Booking state machine** — ✅ **written**. Was the largest gap; unblocked by A4.
- **§11 Spike + workflow decomposition** — each step, its side effect, its retry semantics,
  its idempotency key derivation (A13 gives the rule; §11 applies it). Grading criterion #2.
  Opens with the spike question list, since two of them can change the decomposition.
- **§12 API contracts** — request schema and the response union, one arm per §10 state.
- **§13 Timeline envelope schema.** Blocked on A12 (cheap answer: envelope).
- **§14 Build sequence in increments**, each leaving the service runnable.
- **`CORRECTNESS.md` §5/§6/§7** — happy path, failure taxonomy, test matrix. §10 supplies
  the terminal states these map onto, so this is now mechanical.

Still undecided and not written anywhere, all small, none to be discovered while coding:

- Whether validation happens **before or after** the L1 claim. Validate-first means a
  malformed body does not burn the key; it also means a rejected request's fingerprint is
  never stored, so a corrected retry under the same key succeeds rather than `409`s. That
  is probably right, but it is a decision.
- Whether the idempotency record and the booking record are **one store or two**. They
  overlap heavily; §10.5 argues their *lifecycles* are separate, which is not the same
  question as whether they share a `Map`.
- L2 key derivation is specified for `hold`/`charge`/`refund` but not `consume`/`release`
  — closed by A16 either way, but the table needs the two extra rows.

## 7. Deliberate cuts

Every item here was considered and dropped. Cuts marked **README** must be stated in the
README as known gaps — the assignment grades "what you cut and why", and a cut only counts
as judgment if it is visible.

| Cut | Why | README |
|---|---|---|
| **Claim/start crash-window takeover** (`CORRECTNESS.md` §3.1) | The mechanism needs a state machine, a takeover threshold, and a CAS — and the failure it fixes **cannot be demonstrated locally at all**, because an in-memory store is wiped by the very restart that would trigger it. Keep the analysis, cut the code. | ✅ |
| **Hold expiry** (`expiresAt` is in the given `Hold` type) | A real quadrant, and it interacts with A1(c) — if we return `pending`, the hold can expire underneath us. But it needs timers and a whole extra failure branch. The type contract raises the question, so silence would read as oversight rather than choice. | ✅ |
| **Timeline redaction** | Solves a problem this model does not have: the request carries only `offerId`, `amountCents`, `currency`. No card data, tokens, or PII exist to redact. | ✅ |
| **Automatic refund / compensation (A4)** | The assignment lists it verbatim under "Nice to have (only if you have time)". An explicit terminal state naming the `chargeId` satisfies M6's "never *silently*". Promoting it was over-scoping against an explicit instruction — deferred to §2.2/N1. | ✅ |
| **CAS on state transitions** | Guarded a race that cannot occur once L1 works, L3 is deferred, and the workflow body is replayed deterministically. Kept the state machine, dropped the concurrency ceremony. | — |
| **A service-side event log for the timeline** | A second audit log wearing a disguise — precisely what M8 says not to build. WDK's step/event log plus the booking record's fields cover it, and dropping it removes the two-stream merge and its clock-ordering problem. | — |
| **Idempotency-key format validation** | One trusted upstream caller is assumed; the key only becomes a `Map` key. Hardening for an excluded threat model. | — |
| **Restart recovery / persistent local storage** | Property of the World, not our code (D1.1/C3). Reimplementing it locally would be the hand-rolled durability rejected in D1, testing a mechanism production never runs. | ✅ |
| **Multi-instance support and its tests** | The assignment says "no distributed-systems setup needed" and rules out Postgres. Single-process is the scoped answer; §1.1 requires only that we say so rather than rely on it silently. | ✅ |
| **Redis/Postgres store implementations** | Follows from the above. One sentence naming the primitive (`SET NX`) carries the whole design argument; the code would carry no additional signal. | ✅ |
| **Idempotency record retention/expiry** | Production concern, explicitly out of scope. Worth one line, since a naive TTL would silently break I5. | ✅ |
| **Status endpoint separate from the timeline** (A14) | The timeline already returns current state. Surface area without new information. | — |
| **Metrics / structured logging** beyond the journal projection | The timeline *is* the observability deliverable. | — |
| **Multiple offers per booking, partial fulfilment** | A "complete booking system" is explicitly out of scope. | — |
| **Probabilistic failure injection** (A9) | Flaky tests are worse than no tests; cannot demonstrate a specific quadrant on demand. | — |
| **Server-side pricing from `offerId`** (A7) | Needs a catalogue and a price-mismatch branch we cannot do well in the budget. | ✅ |

Deferred rather than cut: everything in §2.2, which is built only after §2.1 is complete.

## 8. Submission deliverables (do not discover these at the end)

The assignment's submission list, as a checklist:

- [ ] Public GitHub/GitLab repo, runnable in under 5 minutes from a clean clone
- [ ] `README.md` — setup + decisions + known gaps
- [ ] `PROCESS.md` — 5–10 annotated prompts, each with what you wanted / what came back /
      what you kept or threw away and why; plus a half-page reflection covering: approach,
      what was reviewed by hand vs trusted, where the runtime did *not* help, and what
      you would do differently
- [ ] Full session transcript(s), labelled if multiple. Spec files (`PLAN.md`,
      `CORRECTNESS.md`) count as spec-driven-development artifacts and should be included
- [ ] Approximate time spent, with an honest note on where any overrun went

Candidate annotated prompts already generated by this planning session — each is a real
decision with a real reversal or departure, which is what the brief asks for:

1. Ranking durable runtimes, and being corrected on WDK's setup cost by checking the docs
   rather than trusting priors.
2. Rejecting "Node is single-threaded" as a correctness argument → the layered L1–L4 model.
3. Discovering WDK's native run-dedup cannot satisfy M7, and deciding to claim before
   `start()`.
4. Discovering the run-history API after initially concluding it did not exist, and
   collapsing the bespoke provider-call log as a result.
5. Departing from WDK's documented `stepId`-as-idempotency-key guidance (C2.1).
6. Splitting durability into runtime / World / our-store ownership rather than
   reimplementing it locally.
7. Catching that the given provider interface leaves compensating calls unkeyed (A16).

## 9. Notes

- `ASSIGNMENT.md` is gitignored and will not be published. `PLAN.md`, `CORRECTNESS.md`,
  `README.md`, and `PROCESS.md` must therefore stand on their own for a reader who has
  the assignment in hand but not our copy of it.
- The transcript is a graded deliverable. Export before the session is lost.
- If the build exceeds two hours, record where the time went — the assignment asks for
  this explicitly and honesty scores better than a quiet overrun. Note that planning time
  is already substantial; count it and say so.

## 10. Booking state machine `DECIDED`

The definition of M6. Every quadrant of (charged | not) × (booked | not) is a **named
reachable state with its own response arm**, so "handles the matrix" is testable rather than
asserted. Referenced by `CORRECTNESS.md` §3/L4.

### 10.1 Ordering, and the quadrant it eliminates

**hold → charge → consume.** Inventory is the scarce resource and releasing a hold is
cheaper and safer than moving money, so the reversible commitment goes first.

The consequence is worth stating in the README: **we only consume after a successful
charge, so "booked but not charged" is unreachable by construction.** One of M6's four
quadrants is closed by the ordering rather than by handling it. Charging first would have
put money at risk instead of inventory — strictly worse for the same effort.

"Booked" means the hold reached `consumed`. A hold alone is a reservation, not a booking.

### 10.2 States

| | State | Meaning | HTTP | `requiresIntervention` |
|---|---|---|---|---|
| in-flight | `pending` | Claimed, run started, no provider call settled yet | — | false |
| | `held` | Inventory held, not yet charged | — | false |
| | `charged` | Charged, not yet consumed | — | false |
| terminal ✅ | `confirmed` | Charged and consumed. The happy path | `201` | false |
| terminal ❌ | `inventory_unavailable` | Hold failed. Nothing held, nothing charged | `409` | false |
| terminal ❌ | `payment_failed` | Charge failed permanently; hold release attempted | `402` | false |
| terminal ⚠️ | `charged_not_booked` | **The quadrant.** Charge succeeded, consume failed permanently | `409` | **true** |
| terminal ⚠️ | `payment_pending` | Charge returned `'pending'` (A17); outcome not knowable | `409` | **true** |

The in-flight states have **no HTTP mapping** — under A1 the request does not return until
the workflow is terminal, so they are only ever observed on the booking record and in the
timeline. They exist because the state machine needs them, not because a caller sees them.

**Why the intervention states are `4xx` and not `200` or `5xx`.** This went through both
wrong answers before landing, and the reasoning is worth keeping.

- **`200` is wrong** because the booking did not happen. A caller doing `if (res.ok)` shows
  a confirmation for a booking that does not exist — the 2am bug this exercise is about.
- **`5xx` is also wrong**, though for a subtler reason. The argument for it was "a `5xx`
  makes the state visible to monitoring nobody had to write". But that is **using the
  status line as an alerting channel, which is the wrong layer.** A `5xx` here would trip
  retry middleware, drown in whatever noise generic server errors already carry, and
  pollute error-rate SLOs with an outcome that is the workflow behaving *correctly*. The
  server did not fail; the booking did.
- **`409` is right.** The resource is in a state that conflicts with what was asked for —
  literally true. And `4xx` carries the correct instruction to the caller: *do not retry
  blindly, this needs attention.*

**The alerting signal is `requiresIntervention`, not the status code.** A metric or queue
keyed on that flag is how ops finds these — which is what a real platform would do anyway,
and it satisfies I7 far better than a status code ever could.

`409` is shared with `inventory_unavailable` and `idempotency_key_reuse`. That is fine:
`state` (or `error.code`) is the contract, and the status code only carries the class.

Retry safety, whatever the code: a retry re-sends the same `Idempotency-Key` and replays
the stored response (I5). Nothing is charged twice.

### 10.2.1 `requiresIntervention` — a flag, not a state

A boolean on the response and the booking record, true exactly when a human must act.

It is deliberately **not** a state called `needs_manual_intervention`. Collapsing
`charged_not_booked` and `payment_pending` into one bucket would destroy the diagnosis —
they need different actions (refund vs. wait for the provider to settle). The state names
*what happened*; the flag says *who has to do something about it*. Ops filters on the flag,
engineers read the state.

It is also the **alerting signal** — the thing a metric or a queue keys on. That is the job
I had briefly given to the HTTP status code, and it belongs here instead: a flag survives
being read by a dashboard, a filter, or a person, none of which should be parsing status
lines to find bookings that took money and delivered nothing.

### 10.3 Transitions

```
            ┌── hold fails ─────────> inventory_unavailable        409
            │
pending ────┤
            │            ┌── charge fails ───> payment_failed      402  [hold released]
            │            │
            └─> held ────┼── charge pending ─> payment_pending  ⚠️ 409  [hold KEPT]
                         │
                         └── charge ok ─> charged ──┬── consume ok ──> confirmed  201
                                                    │
                                                    └── consume fails ─────────────>
                                                            charged_not_booked ⚠️ 409

⚠️ = requiresIntervention: true          "fails" = permanently, after retries
```

Legal transitions, and nothing else:

| From | To | On |
|---|---|---|
| `pending` | `held` | `hold()` succeeded |
| `pending` | `inventory_unavailable` | `hold()` failed permanently |
| `held` | `charged` | `charge()` returned `succeeded` |
| `held` | `payment_pending` | `charge()` returned `pending` |
| `held` | `payment_failed` | `charge()` failed permanently — **attempt `release()` first**, record `holdReleased` either way |
| `charged` | `confirmed` | `consume()` succeeded |
| `charged` | `charged_not_booked` | `consume()` failed permanently |

Terminal states have no outgoing transitions. An attempted illegal transition throws — a
bug, not a runtime condition.

### 10.4 Two sub-decisions, and why they went the way they did

**A failed hold-release is a field, not a state.** If `charge()` fails permanently and
`release()` also fails, a hold dangles. The booking still resolves to `payment_failed`,
carrying `holdReleased: boolean`.

The reasoning, since this was queried: a dangling hold is genuinely an inconsistency, so it
must be *visible* — but it is not the same kind of inconsistency as `charged_not_booked`.
No money moved, and `Hold` carries `expiresAt`, so **the provider reclaims it without us**.
Making it a separate terminal state would double the failure branch to distinguish two
outcomes that need the same action from the caller (retry the booking) and no action from
ops. `payment_failed` + `holdReleased: false` says everything a state would, in one field.

It does **not** set `requiresIntervention` — expiry resolves it. If holds expired in hours
rather than minutes, that judgement would flip, and that dependency is worth a line in the
README.

Note the honest edge: we cut hold-expiry handling (§7), so "the hold expires" is a property
we rely on **the provider** for, not something our service implements. That is the correct
division — holds belong to the inventory provider — but it should be stated rather than
assumed.

**`payment_pending` is terminal — for now.** Under A17's cheap answer we report the
uncertainty honestly rather than resolving it, with `requiresIntervention: true` so it is
not mistaken for a resting state. If N2 (webhook resume) is ever built it becomes
non-terminal, with `payment_pending → charged | payment_failed`. That is the only transition
the design would need to grow.

**`payment_pending` deliberately does *not* release the hold**, unlike `payment_failed`.
The charge may still settle, and releasing inventory we may be about to owe the customer
would turn an uncertain state into a definitely-broken one. So a `payment_pending` booking
holds inventory until the provider expires it — which is a second reason it carries
`requiresIntervention: true`, and the sharpest argument for N2 if there is ever budget.
This asymmetry with `payment_failed` is intentional and belongs in the README.

It returns `409`, not `202`, even though "we don't know yet" sounds like `202`. `202` would
promise progress that never comes: we have stopped, and a human must pick it up. An honest
`409` plus `requiresIntervention: true` says so. (Under A1 there is no `202` in this API at
all, which removes the temptation.)

### 10.5 Relationship to the idempotency record

The idempotency record's own lifecycle (`claimed → running → terminal`, `CORRECTNESS.md`
§3/L1) is **separate and deliberately so**. It tracks *our execution*; the booking state
tracks *the world*. They fail independently — the asymmetry §2 of `CORRECTNESS.md` exists to
protect. A booking can be `confirmed` while the idempotency record is still being written;
the record stores the terminal response once known, for replay under I5.

**One store or two:** one `Map<idempotencyKey, Record>` plus one `Map<bookingId, Booking>`,
with the booking holding `idempotencyKey` and the record holding `bookingId`. Two maps
because they have two key spaces and two lifecycles, not because they need isolating.

The booking record also carries **`runId`**, written by the handler once `start()` resolves.
The timeline endpoint has only a `bookingId` to work from, so without it there is nothing to
pass to `world.events.list({ runId })`.

## 11. Workflow decomposition `DECIDED` (closes A13)

Grading criterion #2. The rule from A13: **a step boundary exists wherever an at-least-once
retry would otherwise duplicate a real-world side effect.**

### 11.1 What is and is not a step

| | Where | Why |
|---|---|---|
| Validation, fingerprinting, L1 claim, `bookingId` allocation | **Before the workflow**, in the request handler | They must happen before `start()`, and their results become workflow arguments. Also they can reject without creating a run |
| Choosing *which* step runs next, and computing the resulting state | **Workflow body** | Pure control flow over step results. Deterministic — no clocks, no randomness, no I/O |
| `hold`, `charge`, `consume`, `release` | **One step each** | Each is exactly one real-world side effect |
| Persisting the booking record | **The handler, after `await run.returnValue`** | Steps cannot write anything the handler can read — see below |

**One provider call per step, never two.** Two side effects in one step means a retry after
a partial failure re-runs the first — the exact bug this exercise is built around.

#### Why the handler persists, not the step — VERIFIED, not assumed

Two earlier drafts of this section were wrong in opposite directions: the first left
persistence unspecified, the second put it inside the step. The V1 probe settled it by
measurement (`tests/probe.integration.test.ts`, Q3):

> **Steps execute in a separate module instance.** A counter incremented inside a step read
> back as `2` step-side and `0` caller-side, and module state written by the HTTP handler
> read as `null` inside the step. Writes do not cross in **either** direction.

So a step writing to the booking `Map` writes to a copy the handler and the timeline
endpoint can never read. The shape that works:

1. Steps are **pure provider wrappers** — they take what they need as arguments and return
   the provider's result. No booking id, no store access.
2. The **workflow body** computes the resulting state from step results and returns the
   terminal record: `{ state, holdId, chargeId, reason, holdReleased }`.
3. The **handler** awaits `run.returnValue` and writes the booking record.

This is simpler than the alternative and costs nothing observable: §10.2 already
establishes that in-flight states have no HTTP mapping under a fully synchronous A1, so no
caller ever sees `held` or `charged` — and WDK's step log still records them for the
timeline.

The one consequence to accept: if a run fails catastrophically, the booking record stays
`pending` rather than showing how far it got. The timeline still shows every step that ran,
so nothing is lost for diagnosis. Same class as the restart gap in `CORRECTNESS.md` §4.5,
now with a second cause.

### 11.2 The steps

Every step is annotated in code with the answer to *"what does a retry of this do in the
world?"*, because that is the question being graded.

| Step | Signature | Retry does what, in the world | `maxRetries` | Fatal when |
|---|---|---|---|---|
| `holdStep` | `(offerId, idemKey) → Hold` | Returns the **same** hold — the key makes it a read-repair | 3 | Offer unknown / sold out |
| `chargeStep` | `(amountCents, currency, idemKey) → Charge` | Returns the **same** charge. This is the one that must never duplicate | 3 | Card declined |
| `consumeStep` | `(holdId) → void` | No-op; the hold is already `consumed` (A16 — resource identity) | 5 | Hold expired |
| `releaseStep` | `(holdId) → void` | No-op; the hold is already `released` | 2 | Hold already `consumed` |

Pure provider wrappers, per the finding above — no `bookingId`, no store access. Everything
a step needs arrives as an argument, which is also what A18 requires, and it makes the
persisted step `input`/`output` exactly the provider call (D1.1/C2), which is what lets the
timeline project it without a bespoke log.

#### Mock provider state — VERIFIED across step routes

Steps compile into isolated routes, so "all steps are step-side" does not by itself imply
they share one module instance. Probed rather than assumed
(`tests/probe-providers.integration.test.ts`):

| | Checked | Result |
|---|---|---|
| P1 | `holdStep` creates a hold | ✅ |
| P2 | `consumeStep` reads and consumes **that exact hold** | ✅ |
| P3 | `releaseStep` reads a hold created by `holdStep` | ✅ |
| P4 | A retried step sees the provider's prior idempotency record | ✅ |
| P5 | Charge state survives separate charge-step invocations | ✅ |

`distinct step module instances: 1`. **All step routes share one module instance.** So the
mock providers can hold state in module-level `Map`s with no shared backing — provided
every provider access happens inside a step. That proviso is the design already
(§11.1), so nothing changes.

P4 is worth calling out: the step committed a charge and *then* threw, WDK retried it, and
the retry found the committed record via the same idempotency key rather than charging
again. That is I1 — the exercise's central case — demonstrated against the real runtime
before any booking code exists.

**Two consequences for later work:**

- **Provider state is invisible to the handler.** N3 (provider-side state in the timeline)
  would need a step to read it, not a direct call from the timeline endpoint. Worth knowing
  before starting N3, since it is no longer quite as cheap as §2.2 implies.
- **Provider state does not reset between tests in a file.** The vitest plugin clears
  *workflow* data per file, but module state accumulates — the probe ended with 12 holds
  after 6 runs. Tests must therefore use **distinct idempotency keys and offer ids per
  test**, which the probe does via a `runKey` prefix. This is more realistic than a reset
  hook anyway, and it avoids adding a test-only step whose sole job is clearing state.

Notes on the numbers, which are judgement rather than convention:

- `consumeStep` gets the **highest** budget. It is the last step before `confirmed`, and
  every permanent failure there lands in `charged_not_booked` — the one state that costs a
  human. Money is already committed, so trying harder is nearly free.
- `releaseStep` gets the **lowest**. It is best-effort cleanup; the provider expires the
  hold anyway (§10.4), and a long retry loop delays the caller's `payment_failed` response
  for no benefit.
- `FatalError` is thrown for anything a retry cannot change — declines, unknown offers,
  illegal transitions. `RetryableError({ retryAfter })` for transient ones. This is the
  distinction criterion #2 is asking about, and it is why the classification lives in the
  step rather than in a shared retry policy.

### 11.3 The workflow returns failures; it does not throw them

**Rule: the workflow body catches every *modelled* failure and returns a terminal record.
Only genuinely unexpected errors are allowed to propagate.**

This is what makes the rest of the contract work. When a step exhausts its retries or
throws `FatalError`, WDK surfaces the error into the workflow body. If the body lets it
propagate, `run.returnValue` **rejects** — and the handler awaiting it cannot tell
`payment_failed` (a modelled outcome with a `402` and a typed body) from a bug in our own
code. Every failure arm of §12.1 would collapse into one opaque `500`.

So the body is shaped:

```ts
try   { charge... }                        // step throws after retries are exhausted
catch { return { state: "payment_failed",  // modelled: return, never rethrow
                 reason: describe(err),
                 holdReleased: await releaseStep(holdId) } }
```

Two consequences worth stating:

- **`reason` is built here**, in the workflow body, from the error the step surfaced. It is
  the only place that has both the error and the context to describe it.
- **`CORRECTNESS.md` §6.3's "the only `500` in the API" is true only because of this
  rule.** A rejected `returnValue` means something we did not model went wrong, which is
  exactly what a `500` should mean.

### 11.4 Idempotency keys

Per A16, only the two creates take keys:

```
bkg:${bookingId}:hold      → holdStep
bkg:${bookingId}:charge    → chargeStep
```

Derived by one pure function of `(bookingId, literal step name)` with no access to workflow
or step metadata, unit-tested against a frozen table (`CORRECTNESS.md` §3/L2). `consume` and
`release` are keyed by `holdId`, which is the resource itself.

### 11.5 Validation before or after the claim

**Validate first, then claim.** A malformed body should not burn an idempotency key —
otherwise a client that fixes its payload and retries with the same key gets a permanent
`409` for a booking that never existed.

The consequence, accepted knowingly: a rejected request's fingerprint is never stored, so a
corrected retry under the same key succeeds rather than conflicting. That is the right
trade — we only guard against *divergent successful* requests sharing a key, which is what
I5 actually protects.

## 12. API contracts `DECIDED`

### 12.1 `POST /bookings`

```
Headers:  Idempotency-Key: <string>        (required — A2)
          X-Chaos: <scenario>               (optional — A9, test/demo only)

Body:     { offerId: string,
            amountCents: integer > 0,
            currency: string (3 letters) }
```

Response — a discriminated union on `state`, one arm per §10 state:

```jsonc
// 201 — confirmed
{ "bookingId", "state": "confirmed", "requiresIntervention": false,
  "holdId", "chargeId" }

// 402 — payment_failed  (+ "holdReleased": bool)
// 409 — inventory_unavailable
// 409 — charged_not_booked | payment_pending  ("requiresIntervention": true)
{ "bookingId", "state", "reason", "requiresIntervention",
  "holdId"?, "chargeId"? }

// 400 — validation failed, or Idempotency-Key missing   (no booking created)
// 409 — idempotency_key_reuse: same key, different fingerprint (A3)
{ "error": { "code", "message" } }
```

`reason` is a short human string — *"consume failed after 5 attempts: hold expired"* — for
the on-call engineer, not for programmatic branching. Branch on `state`.

Every response carries a `bookingId` wherever a booking was created, including the failure
arms, so the caller always has the key to `GET /bookings/:id/timeline`.

### 12.2 `GET /bookings/:id/timeline`

`200` with the A12 envelope; `404` typed if the `bookingId` is unknown.

```jsonc
{ "booking": { "id", "idempotencyKey", "fingerprint", "state", "reason",
               "requiresIntervention", "holdId", "chargeId", "holdReleased",
               "createdAt", "updatedAt" },
  "runId": "run_...",
  "events": [ { "at", "type", "stepName"?, "attempt"?, "durationMs"?,
                "idempotencyKey"?, "input"?, "output"?, "error"? } ] }
```

Events are projected from `world.events.list({ runId })` and `world.steps.list({ runId })`,
hydrated with `hydrateResourceIO` (D1.1/C2). No event log of our own.

### 12.3 Errors we deliberately do not model

No auth, no rate limiting, no pagination on the timeline. A booking has ~10 events.

## 13. Build sequence — thin verticals

Each vertical leaves the service runnable, ends in a commit, and carries its own tests.
Build them in order; do not start one before the previous is green.

| # | Vertical | Ships | Tests |
|---|---|---|---|
| **V1** | **Walking skeleton** — Hono + WDK wired, one workflow, `POST` → `hold` → `charge` → `consume` → `201`, all providers scripted `ok` | The happy path, end to end | 1 happy-path test |
| **V2** | **Idempotency** — fingerprint, L1 claim, in-flight promise on the record, replay, `409` on mismatch | M1, M7, I4, I5 | replay, conflict, **T-conc-1** |
| **V3** | **Failure modes** — provider scripts (`http_5xx`, `timeout`, `applied_then_lost`, `pending`), retry classification, `FatalError`/`RetryableError` | M4, M5, and L2 under retry | `applied_then_lost` on hold and on charge |
| **V4** | **State machine** — all eight states, `release` on payment failure, `requiresIntervention`, full response union | M6 — the four quadrants | one test per terminal state |
| **V5** | **Timeline** — the envelope, projected from the World SDK | M8 | timeline after success, and after `charged_not_booked` |
| **V6** | **Docs** — `README.md`, `PROCESS.md`, known gaps | M9, M10, M11 | — |

**V1 is deliberately first and deliberately thin.** It is the vertical that touches every
unverified WDK assumption (A18, `world.runs.list()` from a test, `getRun().returnValue`
cross-request, provider singletons across the step boundary, Vitest + the bundler plugin) at
the point where they are cheapest to fix. It replaces the spike we chose to skip.

**Stop-and-discuss triggers.** Raise these rather than working around them:

- Any WDK behaviour that contradicts D1.1 (C1–C3) or A18.
- `world.runs.list()` not reachable from a test process → M7's evidence changes shape.
- The Vitest/bundler integration needing more than ~15 minutes.
- Any vertical running long enough to threaten the ones after it — V5 and V6 are the ones
  that get squeezed, and V6 is graded highest.

**Final pass, after V6:** exercise the service by hand with curl against each failure
scenario, then add integration or unit tests for anything that hand-testing showed the
suite does not actually cover.
