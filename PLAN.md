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

### 1.1 Standing constraint: dev-easy, production-shaped

A clean clone must run in under 5 minutes with no Docker, database, or cloud account —
**and** no correctness argument may depend on properties that hold only in that local
configuration. Invariants live behind interfaces whose contract is the distributed one;
the in-memory implementations are a legitimate degenerate case of that contract, not a
shortcut around it. Full statement and the rules it generates: `CORRECTNESS.md` §1.

This constraint has teeth — it is what rules out justifying the idempotency claim by
"Node is single-threaded" (see D1.1/C1), and what motivates the two-instance concurrency
test (`CORRECTNESS.md` §4.3, T-conc-2).

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

### 2.1 Core — build this first, and completely

Nothing outside this list may be started until all of it works. In priority order:

1. `POST /bookings` with L1 atomic claim + fingerprint replay/conflict (M1, M7)
2. The two mock providers with scripted failure modes (M3, M4, M5)
3. The workflow: hold → charge → consume, deterministic keys per L2 (M2, M6)
4. Compensation for the charged-but-not-booked quadrant (M6, and see A4)
5. `GET /bookings/:id/timeline` projecting WDK's log + our records (M8)
6. The targeted test set (§12 when written; `CORRECTNESS.md` §4.3)
7. `README.md`, `PROCESS.md` (M9, M10, M11)

### 2.2 Nice-to-have — do not start until §2.1 is done

| # | Item | Trigger to build it |
|---|---|---|
| N1 | Webhook/hook resume for a `pending` charge | Only if A17 lands on "resolve it"; otherwise `pending` is just an explicit state |
| N2 | Provider-side state in the timeline, reconciled against ours | Cheap (providers are in-process) and high review value, but pure addition |
| N3 | L3 — losing-run convergence via `hook.getConflict()` | Defence-in-depth behind L1; the reasoning is the deliverable, the code is optional |
| N4 | Test T-conc-4 — two runs racing into compensation | Requires machinery to force two runs; the L4 CAS itself is core, proving it under race is not |

### 2.3 Out of scope — from the assignment, do not build

- Authentication, accounts, users. Assume one trusted upstream caller.
- Real third-party APIs. The mock providers are the only sources of truth.
- Any UI. curl and tests are the interface.
- Persistence beyond memory. We do not even use the JSON-file option (D1.1/C3).
- Production concerns: deployment, multi-region, rate limiting, secret rotation.
  **We ship no deploy configuration and no Redis/Postgres implementation.** Naming the
  primitive each would use is design documentation and costs nothing; building either is
  out of scope.
- Comprehensive test coverage. A handful of targeted failure-mode and concurrency tests.
- A "complete" booking system.

**Note on the tension with §1.1.** "Production concerns are out of scope" and "demonstrate
production thinking" are not in conflict, but the line has to be drawn deliberately:
*reasoning* about multi-instance correctness is graded (it is the idempotency criterion);
*building* multi-instance infrastructure is out of scope. So the interfaces are
production-shaped and documented, the implementations are in-memory, and we ship nothing
operational.

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

### A1 — Is `POST /bookings` synchronous or asynchronous? `OPEN`

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

**Resolution:** the header is **required**. Missing ⇒ `400` with a typed error. Also
enforce a sane format (length bounds, printable ASCII) so keys cannot be used to
smuggle control characters into the store or logs. Documented in README.

### A3 — Same key, different request body: replay or reject? `DECIDED`

Stripe's semantics, and the safe ones: an idempotency key identifies *one specific
request*, not "the most recent request from this caller". Replaying a stored response
for a body the caller never sent is a silent wrong answer.

**Resolution:** store a **request fingerprint** (stable hash of the canonicalised body)
alongside the key. Same key + same fingerprint ⇒ replay the stored response (or join the
in-flight run). Same key + different fingerprint ⇒ `409 Conflict`, typed
`idempotency_key_reuse`. The assignment nudges at this by naming "the original request
fingerprint" as a timeline entry, which suggests they expect us to have one.

### A4 — Does the four-quadrant matrix require *automatic* compensation? `OPEN` (leaning yes)

M6 says the service "must never *silently* leave a customer in an inconsistent state".
The word "silently" admits two readings:

- **Weak:** it is acceptable to end in `payment_succeeded, inventory_failed` provided the
  state is explicit, typed, surfaced in the response, and visible in the timeline as
  needing action.
- **Strong:** we must actively compensate — refund the charge, release the hold — and
  only fall back to an explicit terminal "needs human" state when compensation itself
  fails.

That "refund flow when payment succeeded but inventory failed permanently" is listed as a
*nice-to-have* is evidence for the weak reading. But it is hard to claim we "handle" the
charged-but-not-booked quadrant while leaving the customer's money with us.

**Default resolution:** implement the strong reading, because it is the quadrant the
exercise exists to test — with a hard rule that compensation is itself a workflow step
with its own retry policy, and its failure produces a distinct terminal state
(`compensation_failed` / needs-reconciliation) rather than being swallowed. See A5.

Runtime note: WDK documents the saga/compensation pattern directly — accumulate rollback
closures as the workflow progresses, and on failure run them in reverse, with the rollbacks
themselves declared as steps so they are durable and retried. That is close to free, which
strengthens the case for the strong reading.

### A5 — Is compensation-failed a success or a failure to the caller? `DECIDED`

If we refund and the refund fails, the customer is charged and not booked, and we know it.

**Resolution:** this is a distinct terminal state, not an error to be flattened into
`500`. The typed response must name it precisely enough that an on-call engineer can act.
Never return a bare `500` for a state we understand. The timeline must show the intended
compensation, each attempt, and why it stopped.

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

**Resolution:** two layers, one mechanism.

1. **Scripted mode (tests):** the provider is constructed with an explicit script — an
   ordered list of outcomes per method (`ok`, `http_5xx`, `timeout`, `applied_then_lost`,
   …). Fully deterministic, no clocks, no randomness, no sleeps. This is what every
   correctness test uses.
2. **Ambient mode (manual/demo):** a per-request header (e.g. `X-Chaos: payment=timeout`)
   or env var seeds the same script for that booking, so a reviewer can reproduce any
   failure with curl without editing code.

Rejected: probabilistic failure rates as the primary mechanism. Flaky tests are worse
than no tests, and "1 in 10 requests fails" cannot demonstrate a specific quadrant.

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

### A12 — Which timeline events are worth capturing? `OPEN` (proposal below)

The assignment is explicit that this is a judgement call and that dumping everything is
the wrong answer: "pick what's actually useful for someone investigating, not everything
that ever happened."

**Proposal — include:** booking created (with request fingerprint + idempotency key);
idempotent replay / conflict served; workflow run started; step started/completed with
duration and terminal-vs-retryable classification; provider call attempts with the
idempotency key used, the request summary, and the response or error *shape*; each retry
with its reason and the backoff applied; compensation decisions and their outcome; final
state with the reason it was reached.

**Proposal — exclude:** raw HTTP framing, per-poll noise, successful internal validation
steps, and anything that would be identical on every booking.

**Source is now settled (D1.1/C2):** events come from `world.events.list({ runId })` and
`world.steps.list({ runId })` for everything inside a run, merged with our own idempotency
and booking records for everything outside one (conflicts, replays, takeovers). We write no
bespoke provider-call log — a step's persisted `input`/`output` already *is* that record.

Open question is really about *format*: a flat NDJSON event stream is truest to "derived
from the journal"; a structured envelope (`{booking, currentState, events[], providerView}`)
is far easier for a human to read at 2am and lets us fold in N3 (provider-side state
reconciliation). Leaning: envelope, with the events array as the merged projection, and
`runId` included so a reviewer can corroborate against `npx workflow inspect run <runId>`.

One constraint the merge imposes, worth deciding before writing code — **ordering**: our
records and WDK's events have independent timestamps and no shared clock guarantee. Sort by
timestamp, but carry an explicit `source: 'workflow' | 'service'` on every entry so an
investigator can see which clock produced it rather than being silently misled by
interleaving. One field, and it is the difference between a timeline someone can trust and
one that quietly lies about causality.

**Cut: redaction.** An earlier draft required redacting payment-instrument data at
projection time. Re-reading A7, the request carries only `offerId`, `amountCents`, and
`currency` — there is no card data, token, or PII anywhere in the model, so this was
machinery for a problem we do not have. Projecting step I/O wholesale is safe here. Noted
in the README as a thing a real service would need and this one does not.

### A13 — What is durable-runtime "step" granularity here? `OPEN` — unblocked, resolve in §8

D1 has landed, so this is now writable; it lands in §8 (workflow decomposition), which is
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

### A14 — Do we need a status endpoint separate from the timeline? `DECIDED`

**Resolution:** no. If A1 lands on (c), `GET /bookings/:id/timeline` returns the current
state alongside the events, which covers polling. A second endpoint is surface area
without new information. Documented as a deliberate cut.

### A15 — Retry budgets, backoff, and time in tests `DECIDED`

Retries plus real sleeps make a test suite slow and flaky, and wall-clock deadlines
(A1c) make it worse.

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

### A16 — The compensating calls take no idempotency key `OPEN` (leaning: extend)

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

### A17 — `Charge.status: 'pending'` is in the given contract and we have no design for it `OPEN`

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
- **Wait for resolution via a hook/webhook** — this is exactly what N1 is for, and it turns
  the nice-to-have into the natural answer for a state the contract already forces on us.
  `createWebhook` + provider callback resumes the run.
- **Poll with `sleep()`** inside the workflow until it resolves or a budget expires. Durable
  and simple; less elegant than a webhook but far cheaper to build.

**Leaning:** treat `pending` as an explicit non-terminal state now — cheap, satisfies I7,
and it is the *core* answer. N1's webhook resume is the stretch, and only earns its place
if §2.1 is finished. The point stands that it would stop being a bolt-on demo and become
the answer to a state the provider contract already contains. Decide alongside A4 and D3.

### A18 — Steps are isolated routes, so request-scoped state cannot reach them `OPEN` — verify in spike

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

**This must not be justified by Node being single-threaded.** The in-memory implementation
is correct for a single-instance deployment (which Local World is), but the *design* is an
atomic CAS against a shared store, implementable as `SET NX` / `INSERT … ON CONFLICT DO
NOTHING` / conditional `PutItem` without changing a line of calling code. The full layered
argument — including what still holds when this layer fails, and the claim/start crash
window — is `CORRECTNESS.md` §3. That layering is a primary deliverable of the design, not
an implementation detail.

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

What we owe in exchange is precision about which layer owns which guarantee, stated in the
README rather than left implicit:

| Property | Owner | Local | Vercel/Postgres World |
|---|---|---|---|
| Step results persisted, no re-execution on replay | Runtime | ✅ | ✅ |
| At-least-once step execution | Runtime | ✅ | ✅ |
| Interrupted runs resume after crash/restart | **World** | ❌ | ✅ |
| Idempotency claim survives restart | **Our store impl** | ❌ (in-memory) | ✅ (Redis/PG) |
| No double charge / double hold | **Our design (L2)** | ✅ | ✅ |

The last row is the one that matters: **L2 does not depend on any of the rows above it.**
Deterministic provider keys hold under crash, restart, replay, and duplicate runs alike,
in every World. That is why it is the floor (`CORRECTNESS.md` §3.2), and why losing
local persistence costs us nothing in correctness.

So: A8 is closed. We neither build nor claim restart recovery, and the README states which
World would provide it instead of implying we would.

### D2 — HTTP framework and test runner `OPEN` (narrowed)

TypeScript is given. WDK requires a framework integration, which rules out bare
`node:http`. Shortlist: **Hono** (smallest, fast, first-class WDK integration, trivial to
drive in tests via `app.request()`) or **Express** (most familiar to a reviewer). Bias:
Hono, for testability without binding a port.

Test runner: **Vitest**, for async ergonomics, fake timers, and concurrent-test control.
Confirm WDK's build plugin composes with the chosen runner early — steps are compiled into
isolated routes by a bundler plugin, and the testing story was not documented in the
material we could reach. **This is the single biggest schedule risk in the plan; spike it
in the first 15 minutes** (see §11 when written) before building anything on top.

### D3 — Resolution of A1, A4, A12, A16, A17 `OPEN`

Defaults proposed above. Confirm or override before implementation starts.
(A8 closed by D1.1/C3. A18 is spike-blocking rather than author-blocking.)

Summary of what is still open, and what each blocks:

| Item | Decision | Blocks |
|---|---|---|
| A1 | Sync / sync-with-deadline / async | §9 response contract, every test's shape |
| A4 | Auto-compensate vs explicit terminal state | §8 decomposition, N1 scope |
| A12 | Timeline format: NDJSON vs envelope | §10 schema |
| A16 | Extend provider interface with keys, or rely on resource identity | §8, provider mocks |
| A17 | How `pending` charges resolve — and whether that promotes N2 | §8, N2 scope |
| D2 | Hono vs Express; Vitest | Everything (spike first) |

## 6. To be written once D2/D3 land

- §7 Architecture and module layout
- §8 Workflow decomposition: each step, its side effect, its retry semantics, its
  idempotency key derivation (A13 gives the rule; §8 applies it)
- §9 API contracts: request/response types including every failure arm
- §10 Timeline event schema
- §11 Build sequence in increments, each leaving the service runnable
- §12 Test plan (cross-referenced to `CORRECTNESS.md` §7)
- §13 Deliberate cuts and known limitations

## 7. Deliberate cuts

Every item here was considered and dropped. Cuts marked **README** must be stated in the
README as known gaps — the assignment grades "what you cut and why", and a cut only counts
as judgment if it is visible.

| Cut | Why | README |
|---|---|---|
| **Claim/start crash-window takeover** (`CORRECTNESS.md` §3.1) | The mechanism needs a state machine, a takeover threshold, and a CAS — and the failure it fixes **cannot be demonstrated locally at all**, because an in-memory store is wiped by the very restart that would trigger it. Keep the analysis, cut the code. | ✅ |
| **Hold expiry** (`expiresAt` is in the given `Hold` type) | A real quadrant, and it interacts with A1(c) — if we return `pending`, the hold can expire underneath us. But it needs timers and a whole extra failure branch. The type contract raises the question, so silence would read as oversight rather than choice. | ✅ |
| **Timeline redaction** | Solves a problem this model does not have: the request carries only `offerId`, `amountCents`, `currency`. No card data, tokens, or PII exist to redact. | ✅ |
| **Restart recovery / persistent local storage** | Property of the World, not our code (D1.1/C3). Reimplementing it locally would be the hand-rolled durability rejected in D1, testing a mechanism production never runs. | ✅ |
| **Redis/Postgres store implementations** | Out of scope per §2.3. The interface contract and the named primitive carry the design argument; the code would carry no additional signal. | ✅ |
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
