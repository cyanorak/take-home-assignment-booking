## Reflection 
On this assignment I went a little long on the take home task. Probably around 3 hours total.
I had claude look over the whole assignment, saying we would do the extra work if time, but we started with a fairly complete solution that was complicated.
Then I complicated things more, after seeing a partial plan and suggesting we design for production and multiple servers. This complicated the state machine greatly, and after re-reading the instructions seeing this explictly called out as dont do, I greatly simplified.

### Your overall approach
I went first into pulling requirements, constraints, nice to haves, and details for my CORRECTNESS.md at the beginning, then moved onto planning. Planning took longer than I expected as the implementation plan got too complex, more than what was asked for, and I had to cut it back. After the plan and checking the plan we went into a 4 phase implementation. Fixing and writing tests as we went. Then I also used claudes help for the reflection and write up.

### What you reviewed by hand vs. trusted
I reviewed  a lot of the plan by hand and gave feedback. I ended up short on time and scanned code, but did not review as closely as I would have liked.

### Where your workflow runtime doesn't help
The biggest thing was still requiring some local state. My simple approach is not production ready, needing shared state across appservers.

### What you'd do differently next time.
I may have scripped the original ASSIGNMENT.md, which I copied all from the ask, and remove sections like the nice to haves, and make the language more clear around limiting what we implement. Time was my issue going too complicated to begin then needing multiple planning iterations to simplify.

13:00 pushed back on workflow engine
13:08 redirected
13:45 cutting scope
13:57 asking for options
14:20 pushing back on plan after saying it was finished
14:26 changed decision on long polling to simplier synchronous
15:30 Added environment check on chaos testing header


================== EDIT BELOW THIS LINE ==================