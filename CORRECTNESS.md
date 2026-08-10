# CORRECTNESS.md

The guarantees this service must preserve, the reasoning behind them, and the failure
taxonomy the integration tests are derived from.

`PLAN.md` records *what* we are building and what we cut. This document records *what must
remain true* and *how it breaks*. Where the two disagree, this one wins.

Status: §1–§4 written. §5 (happy path), §6 (failure taxonomy), §7 (test matrix) to follow.

---

## 1. Operating premise: dev-easy, production-shaped

**The code in this repository will not run in production. It must nevertheless be written
as though it would.**

Concretely, that means a two-part standard, and both parts are hard requirements:

- **Runnable in under 5 minutes from a clean clone**, with no Docker, no database, no
  cloud account. Locally this means the WDK Local World and in-process adapters.
- **No correctness argument may depend on properties that only hold locally.** Anything
  we rely on for correctness must remain true when the service runs as N replicas behind
  a load balancer, with requests for the same key landing on different instances, and
  instances dying mid-flight.

The reconciliation between those: **correctness lives in an interface whose contract is
the production one; local mode is a legitimate degenerate implementation of that
contract, not a different design.**

### 1.1 The rule this generates

> Any invariant enforced by an in-process data structure must be expressible as a single
> atomic operation against a shared store — and the in-process version must be a
> *substitutable implementation of that same operation*, not a shortcut that sidesteps it.

An in-memory `Map` guarded by "Node is single-threaded" fails this rule as *justification*
while satisfying it as *implementation*. The distinction matters: the single-threaded
event loop makes the in-memory implementation **correct for a single-instance deployment**,
which is precisely the deployment Local World is. It does not make the *design* correct.
If the design's correctness argument is "there is only one process", the design is wrong
and the tests will not catch it, because the tests also run in one process.

### 1.2 How we hold ourselves to it

1. Every such invariant goes behind an interface with an **atomic compare-and-set style
   operation** — not `get()` then `set()`. If the interface cannot be implemented over
   Redis/Postgres/DynamoDB with a single conditional write, the interface is wrong.
2. Each interface ships **two implementations**: in-memory (default, dev/test) and at
   least a documented sketch of the distributed one, with the exact primitive named
   (`SET NX`, `INSERT … ON CONFLICT DO NOTHING`, conditional `PutItem`). Where budget
   does not permit a working second implementation, the sketch and its trade-offs are
   written down rather than implied.
3. **Multi-instance tests without multi-instance infrastructure:** tests construct *two
   independent application instances sharing one store instance* and fire concurrent
   requests at both. This catches any invariant that silently depends on module-level or
   request-local state, which a single-instance test cannot. See §4.3.
4. Any remaining single-instance assumption is listed in §4.5 and in the README, named,
   not buried.

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

Implementations:

| Environment | Primitive |
|---|---|
| Local / test | `Map.has()` + `Map.set()` in one synchronous turn (atomic on a single instance) |
| Redis | `SET key payload NX` |
| Postgres | `INSERT … ON CONFLICT DO NOTHING`, unique index on the key |
| DynamoDB | `PutItem` with `ConditionExpression: attribute_not_exists(pk)` |

The interface is deliberately shaped so all four are one round trip:

```
claim(key, fingerprint) -> { outcome: 'claimed' }
                         | { outcome: 'exists', record: IdempotencyRecord }
```

There is no `get`-then-`set` in the interface. That absence is the design.

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
| L1 failed, two runs | **differs ⇒ double charge** | same ⇒ safe |
| §3.1 claim takeover | **differs ⇒ double charge** | same ⇒ safe |
| WDK native dedup (starts 2 runs by design) | **differs ⇒ double charge** | same ⇒ safe |

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

### L4 — Compare-and-set on decision transitions (prevents split-brain compensation)

The specific hazard L2 cannot touch: run A concludes inventory failed permanently and
refunds; run B, still live, consumes the hold. Both calls are individually legitimate and
individually idempotent. The customer ends up with a refunded, consumed booking.

Therefore **every transition that authorises an irreversible real-world action is a
conditional write on the booking's current state**, not an unconditional one:

```
transition(bookingId, from: 'charged', to: 'compensating') -> boolean
```

A run that loses the CAS does not take the action. This is the same primitive as L1
applied to state rather than to keys, and it is the layer that actually protects I3.

Guarantee: **I3**, under concurrent runs.

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
| L3 (convergence) | I1, I2 | L2 |
| L4 (decision CAS) | I1, I2, but **I3 is at risk** | — |

L2 is the floor and must never be compromised for convenience. If a change makes a
provider key non-deterministic, that change is wrong regardless of what else it improves.

### 3.3 Where L2 does not reach

Two cases in the assignment's own provider contract fall outside L2's protection. Both are
`OPEN` in `PLAN.md`; recorded here because they are gaps in a *guarantee*, not merely
undecided design.

**(a) The compensating calls carry no idempotency key.** `release(holdId)`,
`consume(holdId)`, and `refund(chargeId)` are unkeyed in the given interface, while
`hold()` and `charge()` are keyed. Every one of them is a retryable step with an
irreversible real-world effect, so L2 as stated does not cover the compensation path — the
exact path I3 depends on. Until `PLAN.md` A16 is resolved, **I3 is guaranteed only to the
extent that repeat calls are no-ops by resource identity**, which is an assumption about
provider behaviour rather than something we enforce. A double refund is the worst case: a
real financial loss that, unlike a double charge, no customer will report.

**(b) A `pending` charge cannot be resolved by retrying.** The given `Charge` type admits
`'pending'`. L2 turns a retry into a read-repair, but read-repairing a pending charge
returns `pending` again — the information does not exist yet at the provider. This is the
one failure mode where *no* idempotency scheme helps, because the ambiguity is in the
world, not in our knowledge of it. The only correct responses are to wait (webhook or
poll) or to represent the uncertainty honestly in the response and the timeline (I7).

Both belong in the failure taxonomy (§6) when it is written, and neither should be allowed
to disappear into "the mocks always return succeeded".

## 4. Execution model assumptions

### 4.1 What we may assume

- The idempotency store and booking store are **linearizable for single-key conditional
  writes**. Redis, Postgres, and DynamoDB all provide this. It is the weakest assumption
  that makes L1 and L4 work, and we assume nothing stronger — in particular, **no
  multi-key transactions and no cross-store atomicity**.
- Providers are idempotent on the keys we supply, and their idempotency is durable
  (assignment M4).
- The workflow runtime executes each step **at least once**, and persists step results so
  completed steps are not re-executed on replay.

### 4.2 What we must not assume

- ❌ One process, one instance, or process-local state surviving anything.
- ❌ Steps run exactly once. They do not. Every step must be safe to run twice.
- ❌ A provider call that threw did not take effect (A10 — this is the whole exercise).
- ❌ Wall-clock ordering between instances, or synchronised clocks.
- ❌ That a workflow, once started, will finish. Instances die.
- ❌ That the store and the provider can be updated atomically together. They cannot; this
  is why every provider call is bracketed by a durable record of *intent* before and
  *outcome* after (I6).

### 4.3 Testing the assumptions we cannot deploy

Since we cannot run N replicas in a take-home, tests must attack the assumptions directly.
The assignment asks for "a handful of targeted tests", so this list is deliberately short
and ordered — build top-down and stop when the budget runs out:

- **T-conc-1** *(core)* — two concurrent POSTs, same key, one app instance. Asserts I4 via
  `world.runs.list()`, the runtime's own registry (`PLAN.md` A11). This is the test the
  assignment explicitly requires.
- **T-conc-2** *(core)* — two concurrent POSTs, same key, **two independently constructed
  app instances sharing one store**. Fails if any invariant leaked into module-level or
  request-local state, which T-conc-1 structurally cannot detect. ~10 lines, and it is what
  makes the §1.1 production claim testable rather than asserted.
- **T-conc-3** *(core, lowest priority of the three)* — L1 disabled by injection, two runs
  forced. Asserts I1/I2 still hold via L2, proving the layers are genuinely independent
  rather than nominally so. This is the best single piece of evidence for the layered
  design; cut it only if the budget is genuinely gone.

Deferred and cut, recorded so the absence is deliberate:

- **T-conc-4** — two runs racing into the compensation decision (asserts L4's CAS admits
  exactly one). Deferred to `PLAN.md` §2.2/N4: forcing the race needs machinery, and the
  L4 CAS itself is core and unit-testable without it.
- **T-crash-1** — claim takeover. **Cut with the mechanism** (§3.1): there is nothing to
  test, because an in-memory store does not survive the restart that would trigger it.

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
(claims, conflicts, replays, takeovers), per D1.1/C2.

### 4.5 Development is not production, and is not pretending to be

Local mode is deliberately ephemeral. **In development, the expectation is not
persistence** — in-memory stores, in-memory queue, state gone on restart, tests that start
from nothing every time. This is a feature: it keeps the clean-clone path to under 5
minutes and the suite fast, and it stops us writing recovery code that production would
never execute.

The discipline that makes this safe is §1.1 — the *interfaces* are production-shaped, so
what changes between environments is an implementation, never a design.

| Property | Owned by | Local | Production |
|---|---|---|---|
| Step results persisted; no re-execution on replay | Runtime | ✅ | ✅ |
| At-least-once step execution | Runtime | ✅ | ✅ |
| Interrupted runs resume after restart | **World** (env var) | ❌ | ✅ |
| Idempotency claim survives restart | **Store impl** | ❌ | ✅ |
| Atomic claim across instances | **Store impl** | n/a (1 instance) | ✅ |
| **I1/I2 — no double charge or hold** | **L2, our design** | ✅ | ✅ |

The bottom row is the point: **I1 and I2 depend on none of the rows above them.**
Deterministic provider keys hold under crash, restart, replay, duplicate runs, and every
World. Losing local persistence therefore costs zero correctness — it costs only liveness,
and only locally.

Accepted limitations, to be stated plainly in the README rather than implied:

- Multi-instance correctness rests on the interface contract plus T-conc-2/3, not on a
  deployed distributed store. We ship no Redis or Postgres implementation; we specify the
  exact primitive each would use (§3/L1).
- Crash-resumption is not demonstrated, because the World a reviewer runs does not provide
  it. We name the World that does rather than claiming the property.
- **A claim stranded in `claimed` is never recovered** (§3.1). We can describe the fix
  precisely and chose not to build it, because no test in this repo could exercise it.
- Idempotency records are never expired. A production deployment needs a retention policy,
  and a naive TTL would silently break I5 by evicting a key whose response is still
  replayable.
- I3's guarantee on the compensation path depends on how §3.3(a) is resolved.

## 5. Happy path

*To be written.*

## 6. Failure taxonomy

*To be written: the four-quadrant matrix, provider failure modes (transient 5xx, timeout,
applied-then-lost), unknown outcomes, expiry, compensation failures, network and runtime
faults, and the terminal state each produces.*

## 7. Test matrix

*To be written: each row a scenario, its provider script, the expected terminal state, the
expected response, and the invariants asserted.*
