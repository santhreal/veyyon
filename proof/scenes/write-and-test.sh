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
# The function asked for has to be one the shipped rules allow. `ts-no-tiny-functions`
# is on by default and says not to extract a one-or-two line wrapper around an
# expression, so a request for a clamp helper is answered by injecting that rule,
# reverting the edit, and explaining why -- correct behavior, and an empty recording.
# A parser with a validated failure mode is real work by the same rule's standard.
settle 20
shot idle

submit "reply with the single word ready"
settle 35

submit "add an exported function parseWindowSpec(spec: string) to src/utils.ts that parses a limit-per-window string like \"5/60s\" or \"120/1m\" into { limit, windowMs }, rejecting a malformed spec, a non-integer limit and a zero window with a thrown Error naming the input. Then run bun test src/rate-limiter.test.ts and tell me whether the suite still passes."
settle 80
shot edit-diff
settle 70
shot test-run

wheel_up 8
sleep 1.5
shot scrolled
