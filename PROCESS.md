## Reflection 
On this assignment I went a little long on the take home task. Probably around 3 hours total.
I had claude look over the whole assignment, saying we would do the extra work if time, but we started with a fairly complete solution that was complicated.
Then I complicated things more, after seeing a partial plan and suggesting we design for production and multiple servers. This complicated the state machine greatly, and after re-reading the instructions seeing this explictly called out as dont do, I greatly simplified.

### Your overall approach
I went first into pulling requirements, constraints, nice to haves, and details for my CORRECTNESS.md at the beginning, then moved onto planning. I put the complete assignment into ASSIGNMENT.md, and purposefully did not commit it to the public repo. Planning took longer than I expected as the implementation plan got too complex, more than what was asked for, and I had to cut it back. After the plan and checking the plan we went into a 4 phase implementation. Fixing and writing tests as we went. Then I also used claudes help for the reflection and write up.

### What you reviewed by hand vs. trusted
I reviewed a lot of the plan by hand and gave feedback. I ended up short on time and scanned code, but did not review as closely as I would have liked.

### Where your workflow runtime doesn't help
The biggest thing was still requiring some local state. My simple approach is not production ready, needing shared state across appservers.

### What you'd do differently next time.
I may have edited the original ASSIGNMENT.md, which I copied all from the ask, and remove sections like the nice to haves, and make the language more clear around limiting what we implement. Time was my issue going too complicated to begin then needing multiple planning iterations to simplify.

## Known gaps
- No automatic refund (deferred by decision, see prompt 7).
- Single process, in-memory: nothing survives a restart, and in-flight runs do not resume —
  that last one is a property of the WDK World, not of this code.
- Nothing evicts. A real deployment needs a retention policy for idempotency records.
- A `pending` charge is reported, never resolved. Resolving it needs the webhook flow.

# Annotated prompt notes
13:00 pushed back on workflow engine, Vercel
13:08 redirected
13:45 cutting scope
13:57 asking for options
14:20 pushing back on plan after saying it was finished
14:26 changed decision on long polling to simplier synchronous
15:30 Added environment check on chaos testing header


## AI Assisted Annotated prompts

I took my notes and had Claude fill them out for these examples.

---

**1. "I have not used Vercel Workflows but this is my preference... You had it last as most difficult to set up so I want to check my assumptions."** *(13:00)*

*Trying to do:* choose the durable runtime. The assistant had ranked four options and put
Vercel's WDK last on setup cost, recommending a hand-rolled engine.

*Got back:* on being challenged, it went and read the actual docs and reversed itself. The
Local World is bundled, zero-config, no Docker, no account. It had ranked from priors, not
evidence.

*Kept / threw away:* threw away the hand-rolled recommendation entirely. My argument was
that hand-rolling a simplified durable engine demonstrates *less* understanding of how hard
durable execution is, not more. Reading the docs also surfaced three things that shaped the
whole design — see prompts 2 and 3.

---

**2. Rejecting "Node is single-threaded" as a correctness argument** *(13:08)*

*Trying to do:* the plan justified the idempotency claim by saying Node's event loop makes
check-and-insert atomic. That is true and it is not an argument.

*Got back:* a four-layer model — claim at the API boundary, deterministic provider keys,
run convergence, guarded state transitions — with an explicit account of what still holds
when each layer fails.

*Kept / threw away:* kept the layering. It is the thing I would point a reviewer at. But
see the next entry, because I took it too far.

---

**3. "The company may be thinking we do something simple and internal... document this as only a single server solution."** *(13:45)*

*Trying to do:* undo my own over-correction. I had pushed "design for multiple servers" and
the plan grew store abstractions, a Redis sketch, and multi-instance tests.

*Got back:* agreement, plus a distinction I had missed. The grading criterion says
"idempotency at each layer of the system", and the brief's own framing is "at the API layer,
the workflow layer, the step layer". Those are *our* layers, not distributed ones — so the
model survived the simplification intact and only its implementation shrank.

*Kept / threw away:* threw away every distributed artefact. The brief says "no
distributed-systems setup needed" and rules out Postgres; I had been building against an
explicit instruction. What survived is one honest sentence: depending on single-process
execution is fine, depending on it *silently* is not.

---

**4. WDK's own idempotency pattern cannot satisfy the requirement**

*Trying to do:* use the framework's documented run-deduplication.

*Got back:* it is post-hoc. Both concurrent callers may call `start()`, and the loser detects
the collision *inside* the workflow. The docs say so plainly: "Two concurrent requests can
both observe 'no hook yet' and each call `start()`."

*Kept / threw away:* rejected the native pattern for this requirement. The brief asks that
two simultaneous POSTs "trigger exactly one workflow run" and that we verify the run count —
under WDK's pattern that count is two. The claim moved to the API layer, before `start()`.
Worth saying: Temporal would have provided this natively via `WorkflowId` reuse policy. That
is a real capability difference, and the cost of the runtime choice.

---

**5. Departing from WDK's documented advice on idempotency keys**

*Trying to do:* derive the keys sent to the payment provider.

*Got back:* WDK's docs recommend `getStepMetadata().stepId`. The assistant flagged that this
is wrong for us and explained why: `stepId` is stable across retries *within* a run and
differs *between* runs — and every scenario where the key is load-bearing is a two-run
scenario.

*Kept / threw away:* kept the departure. Keys derive from `bkg:{bookingId}:{operation}`,
enforced by a pure function with no access to step metadata and frozen by a unit test. The
general rule is the reusable part: an idempotency key sourced from execution context
degrades to no protection at exactly the moment protection is needed.

---

**6. "Are there any gaps in the plan?"** *(13:57, and again at 14:20)*

*Trying to do:* check the plan before building, twice — the second time after being told it
was finished.

*Got back:* the first pass found the largest hole: there was **no booking state machine**.
Every document referenced states informally without ever enumerating them, so the
four-quadrant matrix had no definition to test against. The second pass found three
contradictions, including one section saying booking state is persisted inside a step while
another said steps cannot write anything the handler can read.

*Kept / threw away:* kept asking. Both passes changed the design, and the second one caught
an error introduced by the first. "The plan is finished" is not an observation, it is a
hypothesis.

---

**7. Refund: promoted to must-have, then demoted** *(14:20)*

*Trying to do:* handle the charged-but-not-booked quadrant.

*Got back:* the plan had promoted automatic refund to core, arguing you cannot claim to
"handle" that quadrant while keeping the customer's money.

*Kept / threw away:* demoted it. The brief lists "Refund flow when payment succeeded but
inventory failed permanently" *verbatim* under "Nice to have (only if you have time)". The
reasoning was plausible and it was still over-scoping against an explicit instruction. Core
became an explicit `charged_not_booked` state carrying the `chargeId` and a
`requiresIntervention` flag — which is what "never *silently*" actually asks for. That cut
roughly a third of the remaining build.

---

**8. "Did you make it return a 500? I'd prefer a 409 so it doesn't get caught in general HTTP errors."**

*Trying to do:* pick the status code for a booking that took money and delivered nothing.
It had gone 200, then 500.

*Got back:* the assistant had argued 500 on the grounds that a 5xx makes the state visible
to monitoring nobody had to write.

*Kept / threw away:* took the 409. The 500 argument was using the status line as an alerting
channel, which is the wrong layer — it trips retry middleware and buries a *correct* workflow
outcome in generic server-error noise. The server did not fail; the booking did. The alerting
signal is the `requiresIntervention` flag, which a metric or queue can key on.

---

**9. "Does it simplify to drop long polling and just do fully synchronous?"** *(14:26)*

*Trying to do:* reduce the API to the simplest thing that works.

*Got back:* yes, and more than expected. It removed the deadline, the `202` arm,
`timelineUrl`, a provider `slow()` outcome and its test. The one thing it appeared to cost —
a race window where a duplicate has nothing to await — dissolved, because calling an async
function returns its promise *synchronously*, so the promise can be stored on the record in
the same turn as the claim.

*Kept / threw away:* kept the simplification, and it made the concurrency test *stronger*.
Under long-poll the two concurrent callers got different responses (`201` and `202`); fully
synchronous they get byte-identical ones, which is the assertion the brief is really asking
for.

---

**10. "Do not assume all steps share one provider module instance merely because they are all step-side."**

*Trying to do:* verify, before building on it, that a mock provider backed by a module-level
map works across four separate step routes.

*Got back:* a probe with every step reporting a module-instance id, so a failure would say
*which* boundary broke. All five checks passed and the steps shared one instance — but an
earlier probe had already shown that steps do **not** share an instance with the HTTP
handler, in either direction.

*Kept / threw away:* that earlier finding forced a design change twice. The plan had booking
state persisted inside the step; steps write to a copy the handler and the timeline can never
read. It now returns the outcome from the workflow and the handler persists it — simpler than
what it replaced. This is the clearest case where refusing to assume was worth the ten
minutes: the alternative was discovering it three verticals deep.

