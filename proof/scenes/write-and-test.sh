#!/usr/bin/env bash
# A file written by the model, then proven by a test suite it did not write.
#
# The claim the gallery row makes is that an edit lands and the tests still pass, so
# both halves have to be on screen: the diff the edit tool applied, with the file
# named in the block header, and a bash block whose output is bun's own pass line.
# A recording that stops at the diff is a recording of an intention.
#
# One turn, not two. The first take asked for an edit and then for a test to be
# written and run, and the model spent the rest of the recording debugging its own
# broken test file. The suite that proves the edit did no harm is the one already in
# the project, which is also the honest claim: an edit that keeps the suite green.
#
# The function asked for carries a real precondition. Asked for a one-expression
# clamp, the model declined and explained that adding a trivial wrapper was against
# the guidance it had been given, which is a defensible reading and an empty
# recording.
settle 20
shot idle

submit "reply with the single word ready"
settle 35

submit "add an exported function clampSpan(lo, hi, n) to src/utils.ts, beside clampToWindow and in the same style, that throws when lo is greater than hi and otherwise returns n clamped into that range. Then run bun test src/rate-limiter.test.ts and tell me whether the suite still passes."
settle 80
shot edit-diff
settle 70
shot test-run

wheel_up 8
sleep 1.5
shot scrolled
