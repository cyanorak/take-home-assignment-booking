# CLAUDE.md

## Read first

Before planning or changing code, read:

1. `ASSIGNMENT.md`
2. `CORRECTNESS.md`
3. `PLAN.md`

`ASSIGNMENT.md` the requested assignment.
`CORRECTNESS.md` defines the guarantees the implementation must preserve.
`PLAN.md` records the accepted implementation sequence and deliberate cuts.

## Working method

- Work in small increments.
- Keep the service runnable after each increment.
- Commit incrementally.
- Do not implement features outside the current approved plan.
- Before adding an abstraction, identify the concrete requirement it serves.
- Prefer explicit state and behavior over generalized framework code.
- Do not perform unrelated refactors.
- Report assumptions instead of silently resolving ambiguity.