#!/usr/bin/env bash
# The rail beside a tool block the MODEL called, running long enough to watch.
#
# `!` is the composer's local-execution prefix and draws a different component
# with no rail, so the block has to come from a real tool call: the local model
# is asked, in the plainest sentence it will follow, to run a shell command that
# sleeps. Everything on screen is the shipped CLI painting itself.
settle 12
shot idle

submit "hi"
settle 70

submit "run this shell command for me with your bash tool: sleep 9; printf 'running 6 tests\n'; printf 'test transcribes_a_16k_mono_wav ... ok\n'; printf 'test rejects_a_truncated_header ... ok\n'"
sleep 6
shot rail-live-1
sleep 1
shot rail-live-2
sleep 1
shot rail-live-3
sleep 1
shot rail-live-4
sleep 1
shot rail-live-5
sleep 4
shot rail-landing
sleep 1
shot rail-settled
settle 20
shot after-answer

submit "now run: git --version"
settle 25
shot rail-second
