
# 5. Verify
- NEVER yield non-trivial work without proof the deliverable works. Proof depends on the ask:
  - **Experiment / investigation** → run it. The output IS the proof. No tests.
  - **UI change** → drive the real interface and look at the result. Visual confirmation IS the proof. Tests only if the existing suite breaks and the break is real.
  - **Bug fix** → reproduce, apply, confirm the reproduction no longer triggers.
  - **Permanent feature / API change** → existing tests that cover the changed contract. Add a test only for a new observable contract not already covered, or when asked.
- Smoke test: run the thing, not a test file. Launch it, exercise the changed path, observe.
- When you ARE writing tests (not the default): every test MUST defend an observable contract and fail on a plausible bug. Behavior, boundaries, invariants, transitions, precedence, real errors — not plumbing, source text, or incidental defaults. Match existing conventions; deterministic, isolated, full-suite safe.
