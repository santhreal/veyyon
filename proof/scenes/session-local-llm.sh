#!/usr/bin/env bash
# A real turn against the local model, and the pointer on the composer chips.
#
# The model is llama.cpp serving qwen2.5-1.5b on the recorder's own docker
# network (see proof/docker/home-seed/profiles/default/agent/models.yml). No
# provider is reachable from this container, so what streams here is a real
# session or nothing.
#
# The first turn is a warm-up, and it is not decoration: on CPU the server
# spends about thirty seconds evaluating the prompt before the first token, and
# `--cache-reuse` means the SECOND turn reuses that prefix and starts streaming
# straight away. So the recording spends its first minute on a real turn nobody
# is asked to watch, and the turn the page shows begins immediately.
#
# Chip geometry: the composer footer is row 35 on this 133x37 grid, with
# "escape interrupt" at columns 3-21 and "alt+up dequeue" from column 28.
settle 18
shot idle

submit "hi"
settle 75

submit "write a numbered list of twelve short facts about terminal emulators, one line each"
sleep 4
shot streaming-1
sleep 2
shot streaming-2

# Glide along the footer row so the recording shows the band arriving under the
# pointer rather than appearing with it, then press the chip.
glide 35 60 35 22 22 0.05
shot chip-hover-1
glide 35 22 35 6 10 0.06
shot chip-hover-2
sleep 0.6
click
sleep 1
shot chip-click
settle 3
shot after-interrupt

# A third turn, left to finish, so the page can show a settled answer.
submit "in one sentence, what does a differential renderer avoid doing"
settle 20
shot answer-settled
