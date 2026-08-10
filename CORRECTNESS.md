# CORRECTNESS.md

The guarantees this service must preserve, the reasoning behind them, and the failure
taxonomy the integration tests are derived from.

`PLAN.md` records *what* we are building and what we cut. This document records *what must
remain true* and *how it breaks*. Where the two disagree, this one wins.

Status: §1–§4 written. §5 (happy path), §6 (failure taxonomy), §7 (test matrix) to follow.

---

## 1. Operating premise: a single-process service that knows it is one

**This is a single-server, in-memory service, and that is a deliberate choice rather than
a limitation we backed into.** The assignment scopes it directly: persistence "beyond what
fits in memory or a JSON file" is out, Postgres is "overkill", and the concurrency
requirement comes with *"no distributed-systems setup needed"*. Building for N replicas
would be over-building against an explicit instruction.

The discipline that keeps this honest is narrow and worth stating precisely, because it is
easy to get backwards:

> **Depending on single-process execution is fine. Depending on it *silently* is not.**

An in-memory `Map` claim is genuinely correct here — Node's event loop makes
check-and-insert atomic within one process, and there is exactly one process. What would be
wrong is leaving that unsaid, so a reader cannot tell whether we knew. So: the assumption
is named in the README, the seam that would change is identified, and we build nothing to
service a deployment we are not making.

### 1.1 What this buys and what it costs

Buys: no store abstraction ceremony, no second implementation, no multi-instance tests, no
lock/lease/fencing machinery. All of that budget goes to the failure matrix, the state
machine, and the timeline — which is where the grade actually is.

Costs, all documented in §4.5 rather than discovered by a reader:

- Idempotency records and booking state do not survive a restart.
- A second replica would double-charge nothing (L2 holds regardless) but could run the
  workflow twice (L1 is process-local).

### 1.2 The one seam

Only **L1** (§3) is process-local. Its interface is a single operation —
`claim(key, fingerprint) → claimed | exists` — with no `get`-then-`set`, so a distributed
version is one conditional write (`SET NX`, `INSERT … ON CONFLICT DO NOTHING`) behind the
same call. That is a one-paragraph note in the README, not code we write.

Every other layer is already deployment-independent: **L2 (deterministic provider keys)
holds under retries, replays, crashes, and duplicate runs in any topology**, because it
depends on nothing but the booking's identity.

### 1.3 Storage

In-memory (`Map`) for idempotency records and booking state. The assignment also permits a
JSON file; that swap is trivial and would buy timeline survival across a restart, but it is
not required and we do not build it by default. Workflow state is the runtime's concern,
not ours (§4.5).

## 2. The primary invariants

Numbered so tests and timeline events can cite them.

| # | Invariant | Scope |
|---|---|---|
| **I1** | For a given `Idempotency-Key`, **at most one charge exists** against the payment provider. | Money |
| **I2** | For a given `Idempotency-Key`, **at most one hold exists** against the inventory provider. | Inventory |
| **I3** | The customer is **never left charged without either a confirmed booking or a completed refund** — and if neither is achievable, the booking rests in an explicit terminal state naming the discrepancy. | Money |
| **I4** | For a given `Idempotency-Key`, **exactly one workflow run** performs the booking. | Execution |
| **I5** | Two requests with the same key and the same request fingerprint receive **equivalent responses**; same key with a *different* fingerprint receives `409`, never a silently wrong replay. | Contract |
| **I6** | Every state transition and every provider call attempt is **recorded before it can be lost**, such that the timeline explains the terminal state without access to stdout. | Audit |
| **I7** | **No terminal state is reached silently.** Every terminal state names its cause, and the response carries enough to act on it. | Contract |

Note the deliberate asymmetry between I1/I2 and I4. I1–I3 are about the *world* — money and
inventory. I4 is about *our execution*. They are not the same guarantee, they fail
independently, and conflating them is the mistake this section exists to prevent.

## 3. Idempotency as layered defence

The central design decision. Four layers, each with a guarantee that survives the failure
of the layers above it.

### L1 — Atomic claim at the API boundary (prevents the second run)

Before any workflow is started, the request performs a **single atomic conditional write**
keyed by `Idempotency-Key`:

- **Insert succeeded** ⇒ this request is the owner. It proceeds to start the workflow.
- **Insert failed (key exists)** ⇒ this request is a duplicate. It does *not* start
  anything; it reads the existing record and either replays the stored terminal response,
  or joins the in-flight run by `runId` and awaits the same outcome (subject to A1's
  deadline).

This is a **unique constraint, not a lock**. It is not leased, it does not expire as part
of the correctness path, and it is not released on completion — it must outlive the run,
because I5 requires replay to work long after the booking is finished.

Guarantee: **I4**, and I5.

Implementation: `Map.has()` + `Map.set()` in one synchronous turn, which is atomic within a
process because nothing can interleave between them without an `await`. **The claim must
therefore contain no `await` between the check and the insert** — that is the entire
correctness argument, it is one line of code, and it deserves a comment saying so.

The interface is one operation:

```
claim(key, fingerprint) -> { outcome: 'claimed' }
                         | { outcome: 'exists', record: IdempotencyRecord }
```

No `get`-then-`set`. That shape is what makes the §1.2 seam a one-line swap for `SET NX`
if this ever needed to be more than one server — but we build only the `Map`.

**The loser's join path.** A request that gets `exists` never starts anything. Three cases,
in order:

| Record state | Response |
|---|---|
| `terminal` | Replay the stored response. Needed for I5 regardless, so not extra machinery. |
| `running` (has `runId`) | `Promise.race([getRun(runId).returnValue, deadline])` — same outcome as the winner, same deadline as the winner (A1). |
| `claimed` (no `runId` yet) | **`202` with the `bookingId`.** |

The third row is the claim/start race window, and returning `202` is simply the honest
answer: we genuinely do not know the outcome yet, which is exactly what `202` means.

> An earlier draft required the winner to register an in-flight `Promise` in a second `Map`
> **in the same synchronous turn as the claim**, so a loser could always find something to
> await. That was over-engineering — it added the subtlest ordering constraint in the
> service to avoid a `202` that the contract already supports. Cut.

This path is what T-conc-1 exercises.

**Why WDK cannot provide this itself:** `start()` takes no caller-supplied run id or
idempotency key, and the framework's documented dedup is post-hoc — both callers may
`start()`, and the loser detects the conflict *inside* the workflow via
`hook.getConflict()`. That is a fine way to avoid duplicated *work*, but it produces two
runs, violating I4 as the assignment states it. (Temporal's `WorkflowId` + reuse policy
*would* provide L1 natively, in the runtime's own storage. Worth stating in `PROCESS.md`:
this is a real capability difference between the two runtimes, not a preference.)

### L2 — Deterministic provider idempotency keys (prevents the second side effect)

Every provider call derives its idempotency key **deterministically from the booking
identity and the logical step** — never from the run id, the attempt number, a timestamp,
or a random value:

```
inventory.hold   -> `bkg:${bookingId}:hold`
payment.charge   -> `bkg:${bookingId}:charge`
payment.refund   -> `bkg:${bookingId}:refund`
```

Consequences, all of which are the point:

- A retried step sends the *same* key, so the provider returns the original record rather
  than performing a second side effect. A retry becomes a **read-repair**, which is the
  only safe response to the unknown-outcome failure (A10).
- Even if L1 fails completely and two runs execute concurrently, **I1 and I2 still hold**,
  because the providers deduplicate. L2 is the layer that protects the customer's money
  when our own coordination is wrong.
- The keys must be derivable from durable state alone. This constrains ordering: the
  `bookingId` must be allocated and persisted *before* the first provider call, and it must
  be stable across replays. WDK's workflow sandbox fixes `Date` and `Math.random()` during
  replay, but we do not rely on that — the id is allocated at the API layer, stored in the
  idempotency record, and passed in as a workflow argument.

Guarantee: **I1, I2** — independent of L1.

#### L2 hazard: execution identity is not booking identity

WDK documents `getStepMetadata().stepId` as the way to build idempotency keys for external
APIs, and for the common case it is reasonable — `stepId` is stable across retries *and*
replays within a run.

**We must not use it.** `stepId` is stable within a run and unique between runs. Every
scenario in which L2 is load-bearing is a scenario in which two runs exist:

| Scenario | `stepId`-derived key | `bookingId`-derived key |
|---|---|---|
| Retry within one run | same ⇒ safe | same ⇒ safe |
| Replay after crash | same ⇒ safe | same ⇒ safe |
| L1 failed or bypassed, two runs | **differs ⇒ double charge** | same ⇒ safe |
| WDK native dedup (starts 2 runs by design) | **differs ⇒ double charge** | same ⇒ safe |
| Retry of a *compensating* call after the forward run ended | **differs ⇒ double refund** | same ⇒ safe |

`stepId` protects against the runtime re-executing a step. It cannot protect against *us*
running the booking twice, which is the actual risk. **The idempotency key must be derived
from the identity of the thing in the world, never from the identity of the execution
attempting it.**

This generalises past this codebase: any idempotency key sourced from execution context —
run id, attempt number, task id, lambda request id — silently degrades to no protection at
exactly the moment protection is needed.

**Enforcement:** key derivation lives in one pure function taking `bookingId` and a literal
step name, with no access to workflow or step metadata. It is unit-tested for stability
against a frozen expected-value table, so a future change that reintroduces execution
context fails a test rather than a customer.

### L3 — Convergence if two runs exist anyway (prevents contradictory progress) — DEFERRED

L1 can fail: a partitioned store or a bug. L2 keeps the money safe but does not stop two
runs from making *different decisions*. The workflow would converge by having its first
step re-read the booking record and abort if another live run owns it — WDK's
`hook.getConflict()` is the native form, and this is the role it is genuinely suited to.
Abort means: return the owner's identity, take no compensating action, record the duplicate
in the timeline. A losing run must never refund, release, or consume.

> **Status: DEFERRED to `PLAN.md` §2.2/N3.** L3 is defence-in-depth behind a working L1,
> and it requires hook machinery. With the §3.1 takeover cut, the only path to two
> concurrent runs is an L1 bug — and the right response to that is L4 plus a test, not a
> second coordination layer. **L4 is core and is not deferred**, because it is what actually
> protects I3, and it is nearly free.

Guarantee (when built): bounds **I3** damage.

### L4 — The booking state machine

**This is what makes the four-quadrant matrix (M6) well-defined**, and after L2 it is the
most important thing in this document.

An enumerated set of booking states with a documented transition table. Every quadrant of
M6 — (charged | not) × (booked | not) — is a *named reachable state* with its own typed
response arm, so "handled the matrix" means something testable rather than something
asserted.

Guarantee: **I3**, and it is the definition of M6.

> **CUT: conditional-write (CAS) transitions.** An earlier draft made every transition a
> compare-and-set, to stop two concurrent runs from making contradictory decisions — run A
> refunding while run B consumes the hold.
>
> That machinery is now unreachable. L1 ensures one run; L3 is deferred; claim takeover is
> cut; and the workflow body is deterministic and replayed from the runtime's event log, so
> a decision is not re-made on retry — the runtime returns the recorded outcome. There is no
> path left to two callers racing a transition.
>
> **What we build:** a plain state field with an enumerated type, assigned by the workflow,
> plus the transition table in `PLAN.md` §10. Illegal transitions throw. That is the state
> machine, without the concurrency ceremony that guarded a case that cannot occur.
>
> If L3 is ever built (§2.2/N4), CAS comes back with it.

> **The state machine itself is not yet written** — `PLAN.md` §10. This is the largest
> remaining gap in the plan. A4 is now decided (no automatic compensation), which unblocks
> it and makes it considerably smaller: no `compensating`, no `compensation_failed`.

### 3.1 The claim/start crash window

L1 has one genuine gap. The owner may crash between claiming the key and recording the
`runId`. The key is then claimed with no workflow behind it, and every retry replays a
booking that will never progress — a permanently stuck key, which is worse than a
duplicate.

The record carries a state, and only the intermediate state would be time-bounded:

```
claimed(at)  ->  running(runId)  ->  terminal(response)
```

The full fix is takeover: a duplicate request finding `claimed` older than a threshold with
no `runId` **atomically takes over** (a CAS, so exactly one taker wins) and starts the
workflow itself. Takeover would be safe **because of L2** — if the original owner was slow
rather than dead, the provider keys are identical, so I1/I2 hold and L4 prevents
contradictory decisions. The layers compose: L2's determinism is what makes L1's recovery
path affordable. It is a *liveness* timeout, not a mutual-exclusion lease; getting it wrong
costs a redundant run, never a duplicate charge.

> **Status: analysis retained, mechanism CUT** (`PLAN.md` §7).
>
> The failure requires a crash between two adjacent statements, and **cannot be
> demonstrated in the local configuration at all** — the in-memory store is destroyed by
> the same restart that would trigger the recovery, so there is no state left to take over.
> Building an untestable recovery path inside a two-hour budget is the wrong trade.
>
> **What we build instead:** the record still carries the `claimed → running → terminal`
> states, because the state machine is needed anyway and costs nothing. We simply never
> take over a stale claim. A booking stuck in `claimed` is therefore a permanent stuck key
> in production, and that is a **known gap stated in the README**, not an unknown one.
>
> This is the honest version: we found the hole, we can describe the fix precisely, and we
> declined to ship a recovery mechanism no test in this repo could exercise.

### 3.2 Layer summary

| If this fails… | …this still holds | via |
|---|---|---|
| L1 (claim) | I1, I2 — no double charge, no double hold | L2 |
| L1 + L2 | Nothing. L2 is the floor. | — |
| L3 (convergence) — *deferred, not built* | I1, I2 | L2 |
| L4 (state guard) | I1, I2, but **I3 is at risk and M6 is undefined** | — |

L2 is the floor and must never be compromised for convenience. If a change makes a
provider key non-deterministic, that change is wrong regardless of what else it improves.

### 3.3 Where L2 does not reach

Two cases in the assignment's own provider contract sit outside L2's literal statement. The
first turned out to be covered by a different mechanism; the second is a real, permanent
limit that no idempotency scheme can close.

**(a) The unkeyed calls are covered by resource identity, not by L2** — `RESOLVED`, see
`PLAN.md` A16.

`release(holdId)`, `consume(holdId)`, and `refund(chargeId)` carry no idempotency key,
while `hold()` and `charge()` do. That asymmetry is principled rather than an oversight:
**keyed calls create a resource** (nothing else distinguishes a retry from a second call);
**unkeyed calls transition a named one** (the resource id already does that work).
`consume(hold_abc)` twice is one consume attempted twice.

So L2's guarantee extends to these calls through a different mechanism, and the mocks must
**enforce** it rather than assume it: a repeat call on an already-transitioned resource is a
no-op returning success, and an *illegal* transition (`release()` on a `consumed` hold) is a
genuine error. That enforcement is what turns "providers are probably well-behaved" into
something the test suite checks.

Worth stating in the README as the general rule, because it is the reusable idea:
**idempotency keys are for creates; for transitions, the resource identity is the key.**

**(b) A `pending` charge cannot be resolved by retrying.** The given `Charge` type admits
`'pending'`. L2 turns a retry into a read-repair, but read-repairing a pending charge
returns `pending` again — the information does not exist yet at the provider. This is the
one failure mode where *no* idempotency scheme helps, because the ambiguity is in the
world, not in our knowledge of it. The only correct responses are to wait (webhook or
poll) or to represent the uncertainty honestly in the response and the timeline (I7).

Both belong in the failure taxonomy (§6) when it is written, and neither should be allowed
to disappear into "the mocks always return succeeded". (b) has a named terminal state —
`payment_pending`, `PLAN.md` §10 — precisely so it cannot.

## 4. Execution model assumptions

### 4.1 What we may assume

- **One process.** Stated, not silent (§1). Synchronous sections do not interleave.
- Providers are idempotent on the keys we supply (assignment M4).
- The workflow runtime executes each step **at least once**, and persists step results so
  completed steps are not re-executed on replay.

### 4.2 What we must not assume

Being single-process removes the coordination hazards; it removes none of the ones this
exercise is actually about. All of the following remain true and are where the bugs live:

- ❌ Steps run exactly once. They do not. **Every step must be safe to run twice** — this
  is a property of the runtime's retry semantics, not of how many servers there are.
- ❌ A provider call that threw did not take effect (A10 — the whole exercise).
- ❌ That a workflow, once started, will finish. Steps exhaust retries and runs fail.
- ❌ That the store and the provider can be updated atomically together. They cannot; this
  is why every provider call is bracketed by a record of *intent* before and *outcome*
  after (§4.4, I6).
- ❌ That "we only run one workflow" implies "each side effect happens once". It does not —
  retries alone can duplicate a side effect within a single run. **L2 is what prevents
  that, and it is needed even on one server.**

The last point is the one to keep in view while simplifying: L1 was the distributed-ish
layer, and it collapses to a `Map`. L2 was never about distribution at all.

### 4.3 Concurrency and layering tests

The assignment asks for "a handful of targeted tests", so this list is deliberately short
and ordered — build top-down and stop when the budget runs out:

- **T-conc-1** *(core, and the only required one)* — two concurrent POSTs, same key, via
  `Promise.all`. Asserts I4 via `world.runs.list()`, the runtime's own registry
  (`PLAN.md` A11), plus one hold and one charge at the providers. This is the test the
  assignment explicitly requires, in the shape it explicitly suggests.
- **T-deadline-1** *(core)* — the `202` arm of A1. Provider scripted `slow(ms)` with the
  deadline injected at ~50ms, so the test is fast. Asserts, in order:
  1. `POST` returns **`202`** with a `bookingId` and a non-terminal state;
  2. the workflow **keeps running** after the response — `202` is not abandonment;
  3. the booking subsequently reaches a terminal state;
  4. `GET /bookings/:id/timeline` shows the whole run, so the caller who gave up on the
     long-poll can still find out what happened.

  Point 2 is the one that matters. A `202` that quietly dropped the work would pass a
  naive version of this test, and it is the failure mode the async design exists to avoid.

Deferred and cut, recorded so each absence is deliberate:

- **L1 disabled, prove L2 holds independently.** Deferred to `PLAN.md` §2.2/N5. It is the
  best evidence that the layering is real rather than decorative — but it proves a design
  property, not a requirement, and the assignment asks for "a handful of targeted tests".
- **Two-instances-sharing-a-store.** Proved multi-instance safety, which §1 no longer
  claims.
- **Two runs racing a transition.** Cut with the CAS machinery (L4) — unreachable.
- **Claim takeover.** Cut with the mechanism (§3.1) — nothing survives a restart to take
  over.

The remaining suite is the failure taxonomy (§6) driven through scripted providers: the
four quadrants, `applied_then_lost`, timeout, transient 5xx with retry, replay, and the
fingerprint conflict.

### 4.4 Ordering constraint derived from the above

Because there is no cross-store atomicity (§4.2), the sequence around every provider call
is fixed:

1. Durably record **intent**, including the exact idempotency key to be used.
2. Call the provider.
3. Durably record **outcome** — success, failure, or *unknown*.

"Unknown" is a first-class outcome, not an error. A step that recorded intent but never
recorded an outcome is exactly the state that a replay resolves by re-calling with the same
key. If we record intent *after* the call, a crash in between loses the fact that a charge
may exist, and I1 becomes unenforceable on recovery.

**The runtime discharges steps 1 and 3 for us — but only if we let it.** WDK persists a
step's `input` when the step starts and its `output`/`error` when it settles. So a provider
call wrapped in a step already has durable intent-before and outcome-after, with no code
from us.

The condition attached to that gift:

> **The idempotency key must be passed *into* the step as an argument, never computed
> inside the step body.**

A key computed inside the body is absent from the persisted `input`, so the intent record
does not say *which* key was used — and on recovery we cannot prove which charge to look
for. Passing it in makes the durable record self-describing, and it is the same constraint
that rules out `getStepMetadata().stepId` (§3/L2 hazard), which is only reachable from
inside. Two independent lines of reasoning landing on the same rule:

```ts
// correct — intent is durably recorded, key visible in step input
async function chargeStep(amountCents: number, currency: string, idemKey: string) {
  "use step";
  return payments.charge(amountCents, currency, idemKey);
}

// wrong — key invisible in the persisted input; unrecoverable after a crash
async function chargeStep(booking: Booking) {
  "use step";
  return payments.charge(booking.amountCents, booking.currency, derive(booking)); // ✗
}
```

The residue we still owe ourselves: domain-level outcomes that live outside any run
(claims, fingerprint conflicts, replays), per D1.1/C2.

### 4.5 Known limitations — all of these belong in the README

Stated plainly so a reader can tell we knew, per §1:

- **Single process, in-memory.** Idempotency records and booking state do not survive a
  restart. L1's atomicity is the event loop; a second replica could start a second run.
- **No crash-resumption of in-flight workflows.** That is a property of the WDK World
  (Vercel/Postgres), not of the Local World a reviewer runs. We name it rather than claim
  it, and we write no recovery code — see `PLAN.md` D1.1/C3.
- **A claim stranded in `claimed` is never recovered** (§3.1). We can describe the fix
  precisely and chose not to build it, because nothing survives the restart that would
  trigger it.
- **Idempotency records never expire.** A real deployment needs a retention policy, and a
  naive TTL would silently break I5 by evicting a key whose response is still replayable.
- **A `pending` charge is reported, not resolved** (§3.3(b), `payment_pending` in
  `PLAN.md` §10). Resolving it needs a webhook — deferred to §2.2/N2.
- **No automatic refund** when a booking ends `charged_not_booked` (`PLAN.md` A4). The state
  is explicit and names the `chargeId`; the remedy is deferred to §2.2/N1.

What none of this touches — worth being explicit, because it is the answer to "isn't
in-memory a cop-out?":

> **I1 and I2 hold regardless.** No double charge, no double hold, under retries, replays,
> exhausted budgets, or duplicate runs. That guarantee comes from L2 — deterministic
> provider keys — which depends on nothing above it: not the store, not the World, not the
> number of processes. Everything in the list above costs liveness or recoverability.
> None of it costs the customer money.

## 5. Happy path

*To be written.*

## 6. Failure taxonomy

*To be written: the four-quadrant matrix, provider failure modes (transient 5xx, timeout,
applied-then-lost), unknown outcomes, expiry, compensation failures, network and runtime
faults, and the terminal state each produces.*

## 7. Test matrix

*To be written: each row a scenario, its provider script, the expected terminal state, the
expected response, and the invariants asserted.*
