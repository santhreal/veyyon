#!/usr/bin/env bash
# The three changes on this branch, in one real session against the local model:
# the rail beside a live tool block, the todo board, and the settings card with
# no tint of its own.
#
# The first turn is a warm-up and is not decoration: llama.cpp spends its first
# turn evaluating the prompt, and `--cache-reuse` means the next turn starts
# streaming straight away.
#
# The tool block is driven with `!`, the composer's local-execution prefix, so
# the rail has something real to run beside for seven seconds rather than
# whatever a 1.5B model decides to call. Everything the recording shows is the
# shipped CLI painting itself.
settle 14
shot idle

submit "hi"
settle 70

# A real streamed answer, so the transcript above the tool block is a session.
submit "in one sentence, what does a differential renderer avoid doing"
settle 24
shot answer-settled

# The rail: seven seconds of a live block, then the settling pass as the result
# lands. Stills across the run catch the highlight at different rows.
submit "!sleep 7; printf 'running 6 tests\n'; printf 'test transcribes_a_16k_mono_wav ... ok\n'; printf 'test rejects_a_truncated_header ... ok\n'"
sleep 1.2
shot rail-live-1
sleep 1.2
shot rail-live-2
sleep 1.2
shot rail-live-3
sleep 1.2
shot rail-live-4
sleep 3
shot rail-landing
sleep 1
shot rail-settled

# A second, shorter block, so the pair reads as two blocks rather than one event.
submit "!printf 'HEAD is %s\n' abc1234"
sleep 1.5
shot rail-second

# The todo board, written by the tool the product ships.
submit "use your todo tool to write a three-phase plan for a transcription pipeline: Foundation with two tasks, Auth with three, Verification with one, then mark the first Foundation task completed"
settle 55
shot todo-board
submit "mark one more todo completed"
settle 45
shot todo-strike

# The settings card, with the pointer travelling down it so the row it leaves is
# still visible while the row it arrives at comes up.
submit "/settings"
sleep 2
shot settings-open
glide 12 40 22 40 20 0.06
shot settings-hover
sleep 0.8
k Escape
sleep 1
shot settings-closed
