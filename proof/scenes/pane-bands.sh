#!/usr/bin/env bash
# The pickers that paint their own rows, hovered by a real pointer, over real
# session state produced by the local model.
#
# These four are not the shared list component: the session tree, the branch
# card, the history search and the session list each paint their rows
# themselves, so each one had to learn the same cross-fade separately.
#
# They also need state before they list anything, which is what the turns at the
# top buy: three user messages, three history entries and a session on disk. The
# first turn is a warm-up -- on CPU the server spends about half a minute
# evaluating a cold prompt before the first token, and --cache-reuse means the
# turns after it start streaming straight away.
#
# A slash command is typed, then Escape, then Return: typing `/branch` opens the
# composer's command popup with `session` highlighted, and a bare Return there
# accepts the popup's row instead of submitting the line. Escape dismisses the
# popup and leaves the text.
#
# No stills: `import` costs about fifteen seconds a frame on this display, which
# would stall the middle of every motion. The page's stills are cut out of this
# recording afterwards.
run() { # run <slash command>
	t "$1"
	pause 0.8
	k Escape
	pause 0.4
	k Return
}

settle 18
submit "hi"
settle 70

submit "in two sentences, what does a differential renderer avoid doing"
settle 34

submit "name one tradeoff it accepts"
settle 26

# The session tree. It travels rather than jumps: measured against the previous
# recording, a bare `point` inside this card leaves the band where it was, and
# only a run of moves walks it. Each move inside this card costs several seconds
# of wall clock, which is why there are two travels and not four.
run "/tree"
settle 4
glide 17 45 12 45 5 0.12
sleep 2
glide 12 45 17 45 5 0.12
sleep 2
k Escape
sleep 2

# The branch card: the user messages, two rows each. `/branch` follows the
# double-escape setting, which the container seeds to `branch`.
#
# Measured off the previous recording: the first message occupies rows 8-9, the
# second 11-12 and the third 14-15. Row 13 is the blank between the second and
# the third, and hovering it bands nothing, which is what the earlier take did.
run "/branch"
settle 4
point 9 45
sleep 1.5
point 12 45
sleep 1.5
point 9 45
sleep 1.5
point 12 45
sleep 1.5
k Escape
sleep 2

# The prompt history search, on ctrl+r, over the prompts this session typed.
# Its five rows start at 8.
k ctrl+r
settle 4
point 9 45
sleep 1.5
point 12 45
sleep 1.5
point 9 45
sleep 1.5
point 12 45
sleep 1.5
k Escape
sleep 2

# The session list, which is the fourth of them. A selected row is never banded
# -- it already wears the selection band, and banding it again would paint the
# same bytes -- so a sandbox with one session on disk can only ever show this
# card with nothing under the pointer. `/new` leaves the session so far on disk
# and starts another, and one turn in the new one gives it a first message to be
# listed by, so the card opens with two rows and the pointer has somewhere to go.
run "/new"
settle 6
submit "name one thing a renderer caches"
settle 40

# The card opens against the top of the screen rather than centred. Measured off
# the recording: row 8 is inside the selected session's block, which never bands,
# and the session before it occupies rows 11-13, which is the block that lights
# up. The pointer alternates between the two so the page can show both answers in
# one still.
run "/resume"
settle 4
point 8 45
sleep 1.5
point 12 45
sleep 1.5
point 8 45
sleep 1.5
point 12 45
sleep 1.5
k Escape
sleep 2
