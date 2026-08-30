#!/usr/bin/env bash
# What the composer footline says about the repository, from the launch card to
# the first `git status`.
#
# WHY THIS SCENE. The footline is painted twice. The launch card draws it on the
# frame the terminal is owed, before any session exists, and the status line
# takes the same row over when the session mounts about a second later. Two
# things were wrong across that seam and this scene is the differential for
# both: the card left the row empty, so the working directory and the branch
# appeared only at the handover, and the dirty marker never arrived at all,
# because `git status` is asynchronous and its landing asked for no repaint. A
# resting session showed a clean branch over a tree nothing had looked at,
# until a keystroke happened to redraw the row.
#
# THE ARMS. The before arm holds the changed sources at the base commit for the
# length of the run, which is `proof/docker/record-x11-before.sh`. Both arms run
# the same seeded project, dirty the same file at the same point, and type the
# same launch line, so the only difference between them is the change.
#
#   PROOF_BASE_REF=<commit before the status-row work> \
#   SCENE_COMMAND='bash -l' SCENE_MOTION_GATE=0 \
#     proof/record.sh --pair proof/scenes/statusline-card-git.sh
#
# WHY THE SHELL. Every other scene starts the app as SCENE_COMMAND, so the card
# is gone before the recorder attaches and the one surface this scene is about
# could not be reached. A shell is launched instead and the launch line is
# typed after recording has started, which puts the card inside the clip. It is
# also what makes the tree dirty in a way both arms share: the file is edited
# from that same shell, one command before the launch.
#
# THE MARKS.
#   dirtied  the shell, with the edit made and the repository one file dirty.
#   card     the launch card, before the session mounts. After: the row names
#            the directory and the branch. Before: the row is empty.
#   resting  the mounted session with nothing typed into it. After: the branch
#            carries `*`. Before: it is clean and stays clean.
#
# `resting` is taken with no input at all, which is the whole point of it. Any
# keystroke repaints the row and would show the marker on both arms.
#
# SCENE_MOTION_GATE=0 because the artifacts here are stills. The gate measures
# unique frames per second across the take to catch a capture that stuttered,
# and a session that is deliberately still fails it while being exactly right.
#
# WHAT THIS SCENE DOES NOT SHOW. One window size, one seeded repository, on a
# branch whose name fits the row whole. A repository whose refs live in a
# reftable has no ref files for the card to read and shows no branch until the
# session mounts; that path needs a repository this sandbox does not seed. Nor
# does it show the other two late lookups that repaint the row, the default
# branch and the pull request, which have no forge to answer them here.
set -euo pipefail

# A shell scene has no model latency to hide a doubled character behind, so it
# types at the slower rate the install row settled on.
TYPE_DELAY="${TYPE_DELAY:-70}"

# The shell's own prompt has to be on screen before anything is typed, or the
# first line lands in a terminal that is still starting.
settle 4

# One tracked file changed, which is the smallest tree `git status` calls dirty.
# Written before the launch so both the card and the mounted row are looking at
# the same repository.
submit "printf '\\n// touched by the scene\\n' >> src/parser.ts"
pause 0.8
shot dirtied

submit "bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b"

# The still that matters is taken between the command and the mounted session,
# so it is a pause rather than a settle: `settle` waits for the screen to stop
# changing, which is the end of the transition this shot is of.
pause 1.2
shot card

# The card is not the session. Waiting for the composer proves the frame above
# was the handover and not a launch that failed.
expect_screen "ask anything" 60

# Long enough for `git status` to have answered several times over on any host
# that can run this container at all, and nothing is typed while it does.
settle 8
shot resting
