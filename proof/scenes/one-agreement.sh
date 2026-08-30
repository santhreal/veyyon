#!/usr/bin/env bash
# A counted row agrees with its count in every word.
#
# Before: only the noun agreed. `/secret log` counted the lines it could not read
#         with a helper and then stated them with a hardcoded plural verb, so one
#         damaged line read `1 line in <path> could not be read and are not shown
#         above`. The same shape said `1 core are bounded by it` on `/cpu` and
#         `These 1 images are` under a withheld picture.
# After:  the verb comes from the same count the noun does, so the row reads `1
#         line ... could not be read and is not shown above`.
#
# The surface is `/secret log` over a seeded log holding two real uses and one
# line the decoder rejects. One unreadable line is the count that needs the
# singular, and the row sits at the foot of the log the command prints, so the
# frame is one command with no model and no network.
#
#   SCENE_MOTION_FLOOR=0 SCENE_SEED_SECRET_LOG=1 \
#     proof/docker/record-x11.sh proof/scenes/one-agreement.sh
#   SCENE_MOTION_FLOOR=0 SCENE_SEED_SECRET_LOG=1 \
#     PROOF_BASE_REF=<the commit>~1 proof/docker/record-x11-before.sh proof/scenes/one-agreement.sh
#
# The floor is zero because the take is still: one command and its answer.
#
# The readable rows in the seeded log are written by the product's own record
# encoder and the unreadable one is a truncated append, so the count under
# capture is the decoder's own count of what it could not parse.

settle 18
shot idle

slash "/secret log"
# needle-source: could not be read -- the malformed-line row `renderLog` writes,
# from secrets/secret-command.ts. Arm-invariant: both arms draw the row and only
# the verb after it changes.
expect_screen "could not be read" 30 "the-log-never-reported-its-unreadable-line"
# The readable rows are the log's ordinary content and the row under test is the
# last line of the same answer: the frame has to show both, or it does not show a
# count agreeing with anything.
# needle-source: most recent use -- the log's own header, from `renderLog`.
expect_screen "most recent use" 20 "the-log-drew-no-readable-rows"
settle 4
shot log
