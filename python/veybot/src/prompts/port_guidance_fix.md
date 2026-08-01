This port is a **fix**. It claims current veyyon has a defect that the upstream
pull request repaired.

**Before you implement.** Produce a failing local reproduction, or an
equivalent observable negative control, on unmodified current veyyon. Record
the exact command and its exact output. If the negative control cannot fail for
the claimed reason, do NOT open a candidate. If local behavior is already
correct, trace the owning path and classify the port as not applicable with
that evidence.

**After you implement.** Prove the regression test fails when only the
production fix is temporarily reversed, then restore the fix and prove the test
passes. Leave the working tree in the passing state. A test that passes both
ways is not evidence, and presenting it as evidence is worse than presenting
none.

**Documentation.** Do NOT edit `docs/handbook/src/` for a fix unless existing
user-facing documentation would otherwise become false. NEVER rebuild or commit
generated handbook pages.
