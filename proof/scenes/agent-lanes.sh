#!/usr/bin/env bash
# Two workers on one session, and the panel that shows them.
#
# A subagent row has to show the part a transcript alone cannot: two lanes running
# at once, each with its own progress, and the control centre listing them while
# they are live rather than after they returned. So the scene opens the panel while
# the workers are still working, and again once they are idle, which is the same
# differential the row claims.
settle 20
shot idle

submit "reply with the single word ready"
settle 35

submit "use two task agents in parallel: one inspects src/rate-limiter.ts and one inspects src/rate-limiter.test.ts. Each reports one concise observation. Neither edits anything."
settle 25
shot lanes-live

slash "/agents"
settle 8
shot control-centre-live
k Escape
sleep 1.5

settle 60
shot lanes-returned

slash "/agents"
settle 8
shot control-centre-idle
k Escape
sleep 1.5
