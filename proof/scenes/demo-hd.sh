#!/usr/bin/env bash
# The demo the landing page shows: a real session, in a real terminal, doing real
# work on a real project, against a dense 32B that actually calls tools.
#
# It exists because the earlier demos were a 1.5B answering questions on a flat
# black terminal, which shows the transcript and nothing the product does: no
# file read, no edit, no command, no plan. Every turn below asks for work with a
# visible result, and the stills are cut at the moment each feature is on screen.
#
# Recorded at 1920x1080 through the themed session (`SCENE_THEME=night`), so the
# capture is the composited terminal a reader would actually have in front of
# them rather than a black rectangle.
settle 20
shot idle

# Warm the server: the first turn pays for the prompt evaluation, and a demo
# should not open on a spinner.
submit "reply with the single word ready"
settle 40
shot ready

# Reading. The model has to find the file itself, which is what puts a read
# block with its rail on screen.
submit "read src/parser.ts and tell me in one sentence what it rejects"
settle 55
shot read-block

# Editing. A real diff, applied by the edit tool, on a file the reader can see
# named in the block header.
submit "in src/parser.ts, make parse also reject a string that is only whitespace, and keep the existing error message style"
settle 90
shot edit-diff

# A command, with output long enough that the block collapses to a preview.
submit "run a bash command that prints the file and counts its lines"
settle 60
shot bash-block

# The plan panel, written by the tool the product ships rather than typed.
submit "use your todo tool: a three-phase plan for hardening this parser, Foundation with two tasks, Validation with three, Release with one, then start the first task"
settle 75
shot todo-board
submit "mark the first Foundation task completed"
settle 60
shot todo-strike

# The settings card, with a real pointer travelling down it so hover is visible.
submit "/settings"
sleep 2
shot settings-open
glide 12 40 24 40 24 0.06
shot settings-hover
sleep 0.8
k Escape
sleep 1.5
shot settings-closed

# The session as a whole: scroll back up through everything the turn produced, so
# the recording ends on the transcript rather than on an empty composer.
wheel_up 12
sleep 1
shot scrolled
wheel_down 12
sleep 1
shot bottom
