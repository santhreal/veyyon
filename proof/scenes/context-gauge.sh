#!/usr/bin/env bash
# The context gauge in the composer footline, moving.
#
# The gauge is the eight-cell bar and the `NN% left` beside it. What moves it is
# a turn: the session sets its in-flight context estimate the moment a prompt is
# sent, so the reading changes on the frame Enter lands rather than when the
# model answers. That is the whole reason this scene never waits for a response
# and interrupts the turn -- the reading has already moved, and the model on this
# network is a 1.5B on CPU that spends about a minute prefilling a prompt this
# size.
#
# One turn, carrying a file mention sized to the server rather than to the card:
#
#   notes.md    20KB, about 5.8k tokens on this tokenizer. The session already
#               holds roughly 25k tokens of system prompt, tools and skills, so
#               the request lands near 31k -- under the 32768 the llama.cpp
#               server actually serves, which is this model's training context
#               and the cap llama.cpp applies whatever `-c` says. A 50KB mention
#               was tried first and the server answered 400 in less than a frame,
#               which drops the in-flight estimate again before any paint can
#               show it: the gauge held its old reading and the recording proved
#               nothing.
#
# The reading travels from 61% left to about 52%, which is nine points of the
# number and a cell of the bar. It cannot cross a heat threshold on this server:
# the hue steps at 50% USED, and 50% of the card's declared 65536 is 32768 --
# exactly the prompt the server refuses.
#
# notes.md is written here rather than by the recorder's bootstrap, because the
# bootstrap's tree is what the popup-grow scene photographs and a new file in it
# would change that page's figures.
#
# No stills -- `import` costs about fifteen seconds a frame on this display and
# would stall the middle of the motion. The page's frames are cut out of the
# recording afterwards.

head -c 20000 /repo/packages/coding-agent/src/modes/components/status-line/component.ts >/sandbox/home/demo/notes.md

settle 18

# --- the reading travels ---------------------------------------------------
# The trailing words matter: they close the mention token, so the file popup is
# gone before Enter, which would otherwise accept a suggestion instead of
# submitting.
t "summarize @notes.md in one word"
pause 1.2
k Return
# The reading moves here, and the prefill holds it: nothing about this wait is
# waiting for the model to say anything.
sleep 6

# Interrupt. Whatever the reading does next is a measurement, not a claim: the
# in-flight estimate is dropped, and what is left is whatever the aborted turn
# left in the history.
k Escape
sleep 6

# The gauge at rest, so the last frames of the take are a settled reading rather
# than a travel cut off by the end of the recording.
settle 4
