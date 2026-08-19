#!/usr/bin/env bash
# Plan mode: a session that reads and reasons, and cannot write.
#
# What makes the row worth a recording is the constraint, not the plan: the mode
# chip in the footer, a read-only pass over two files, and a plan the session
# presents for review instead of applying. So the scene enters the mode first,
# with the chip visible, and asks for work that would otherwise edit.
settle 20
shot idle

# The server is warmed by the runner before the recording starts, with a request that
# never reaches the screen. This scene used to spend its first turn asking the model to
# say "ready", which paid for prompt evaluation in full view: the published row opened
# on a question nobody asked and an answer that means nothing.

slash "/plan"
sleep 2.5
shot plan-mode-on

submit "inspect src/rate-limiter.ts and src/rate-limiter.test.ts only, then plan a sliding-window limiter alongside the token bucket. Do not edit anything and do not use subagents."
settle 60
shot planning
settle 60
shot plan-presented

wheel_up 8
sleep 1.5
shot scrolled
