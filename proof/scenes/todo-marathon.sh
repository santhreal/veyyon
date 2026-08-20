#!/usr/bin/env bash
# A long todo list, written and then closed out, in one real session against the
# local model. The row exists because the board was rebuilt and every claim about
# it is a claim about motion: rows arriving whole and brightening instead of being
# typed, closed work receding while the task in flight stays the only bright row,
# and the anchored HUD going EMPTY at the end rather than collapsing to a line the
# transcript card already carries.
#
# None of that can be shown by a still. A frame proves the settled board; it cannot
# prove that fourteen rows arrive legibly, that the pointer walks itself forward as
# each task closes, or that the region above the composer disappears on the last
# one.
#
# WHY THE LIST IS FOURTEEN TASKS AND NOT FOUR. The layout only has to work once it
# runs out of room: the `… N more open` tail, the phase rows competing with their
# own tasks for weight, and the result text's one line of arithmetic all exist for
# a list too long to print. A four-task board demonstrates none of them.
#
# WHY THE CLOSING IS DRIVEN ONE TASK PER CALL. `done` also takes a phase, and a
# model left to its own judgement closes five tasks in one call -- which is correct
# behaviour and a useless recording, because the board jumps from open to finished
# in a single repaint with no pointer walk in between. The instruction is granular
# on purpose, and it is an instruction rather than a negation ("one per call",
# never "don't batch"): a 27B model reads the noun and drops the qualifier, which
# is what cost take 6 its edit beat.
#
# WHY THERE ARE EIGHT CONTINUE TURNS FOR FOURTEEN TASKS. A scene is a fixed script
# and cannot branch on how many the model closed. Each turn closes some, and a turn
# that arrives after the list is already finished costs one short reply and one
# frame of an empty HUD, which is the shot this row wants anyway. Running out of
# turns before the list closes is the failure that has no recovery, so the count
# errs long.
settle 12
shot idle

# The first turn pays prompt evaluation, and it is not on screen for its own sake:
# the host already warmed the weights, but `--cache-reuse` means the turn after
# this one starts streaming immediately rather than opening on a spinner.
submit "hi"
settle 40

# THE LIST. One init call, phases and counts named, and an explicit instruction not
# to start the work: a model told to plan and left to infer the rest opens the
# session by editing files, and this row is about the board.
submit "use your todo tool to write out the whole plan for shipping an audio transcription service, as five phases in a single init call: Foundation with three tasks, Ingest with three, Transcode with three, Verification with three, and Release with two. Write the list and nothing else -- do not start any of the work and do not write any files."
settle 60
shot list-open

# The board with every row still open is the case the entrance was rebuilt for:
# fourteen rows arriving at once, which is where typing was unreadable.
submit "show me the list again exactly as it stands"
settle 35
shot list-full

# THE WALK. One task per call, and no prose between calls, so what the recording
# shows is the board repainting: the closed row receding to struck dim, the pointer
# moving to the next task, the phase count incrementing under it.
submit "now close the list out. Mark exactly one task completed per todo tool call, in list order, and call the tool again immediately after each one. Do not write any files and do not explain between calls."
settle 45
shot closing-1
submit "keep closing tasks, one todo call per task"
settle 45
shot closing-2
submit "keep going"
settle 45
shot closing-3
submit "keep going"
settle 45
shot closing-4

# Midway, the board is asked for itself: half struck, one row in flight, the rest
# open, which is the three-tier weighting with all three tiers on screen at once.
submit "view the todo list and tell me how many tasks are still open"
settle 35
shot midway

submit "keep going, one todo call per task"
settle 45
shot closing-5
submit "keep going"
settle 45
shot closing-6
submit "keep going"
settle 45
shot closing-7
submit "close whatever is left"
settle 50
shot closing-8

# THE PAYOFF. Every task closed: the anchored region above the composer draws
# nothing at all, and the finished line lives once, on the card that closed it.
submit "confirm the whole list is finished"
settle 40
shot finished
settle 8
shot finished-settled
