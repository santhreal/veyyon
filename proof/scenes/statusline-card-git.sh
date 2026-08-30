#!/usr/bin/env bash
# What the composer footline says about the repository, across the seam between
# the launch card and the mounted status line.
#
# WHY THIS SCENE. The footline is painted twice. The launch card draws it on the
# frame the terminal is owed, before any session exists, and the status line
# takes the same row over when the session mounts about a second later. The card
# used to leave the row empty, so the working directory and the branch appeared
# only at the handover and the row visibly filled in under the reader. This
# scene is the differential for that.
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
# Then hold both arms on the composer band, at the same crop, so the pair
# regenerates from one command:
#
#   for arm in proof/captures/x11 proof/captures/x11/before; do
#     ffmpeg -y -i "$arm/statusline-card-git-card.png" -vf crop=1600:150:0:820 \
#       "$arm/statusline-card-git-card-band.png"
#   done
#
# The band is the crop and not a preference. The welcome hero draws a tip picked
# at random on every launch, so two full-screen arms differ by the change and by
# whichever tip each one drew, and a pair that differs for an unrelated reason
# is not a pair. The band holds the composer and the row under it, which is
# where the change is.
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
#            the directory and the branch. Before: the row is empty. This is
#            the frame the pair is about.
#   resting  the mounted row, for the handover. Both arms are the same here,
#            which is the point: the card is supposed to look like what
#            replaces it.
#
# WHAT THE DIRTY MARKER IS NOT PROVED BY. The same seam carried a second defect
# — `git status` landed without asking for a repaint, so the marker waited for
# whatever redrew the row next. No frame here can show it. Startup in this
# container repaints the row several times on its own (the session index lands,
# the welcome hero gains a row), and any one of those picks up the answer, so
# the before arm shows the marker too. Measured instead, on a pty at 100x30
# with no input at all: the marker reaches the row at 672.6ms with the fix and
# never within eight seconds without it. Held by
# `a-git-read-that-lands-late-repaints-the-status-row.test.ts`.
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
# changing, which is the end of the transition this shot is of. Measured in
# this container, the composer is up inside a second, so the pause is well
# under it.
pause 0.35
shot card
expect_screen "ask anything" 60

# Long enough for `git status` to have answered several times over on any host
# that can run this container at all, and nothing is typed while it does.
settle 8
shot resting
