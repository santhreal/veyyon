#!/usr/bin/env bash
# The first frame of a cold launch: what the terminal shows between the shell
# handing off and InteractiveMode.init finishing.
#
# WHY THIS SCENE EXISTS. Every other scene starts the app as SCENE_COMMAND, so
# kitty is already running it by the time the window is placed and ffmpeg
# attaches. The launch is over before the recorder sees anything, which makes
# the startup frames the one surface no scene could reach. This scene runs a
# shell instead and types the launch line after the recording has started, so
# the frames between the command and the first prompt are in the clip.
#
# WHAT IT SHOWS. The composer zone at rest. Before the change the startup frame
# reserved those rows blank and the prompt appeared only when init finished,
# which reads as the composer sliding up out of the floor. After it the resting
# composer is painted by the first frame and init replaces text in rows that
# never move.
#
# HOW TO RECORD THE PAIR. The subject is motion, so the artifact is the pair of
# clips, not a pair of stills:
#
#   SCENE_COMMAND='bash -l' SCENE_MOTION_FLOOR=0 \
#     proof/docker/record-x11.sh proof/scenes/first-frame.sh
#   SCENE_COMMAND='bash -l' SCENE_MOTION_FLOOR=0 \
#     proof/docker/record-x11-before.sh proof/scenes/first-frame.sh
#
# Then hold both arms on the composer band, at the same crop, so the pair
# regenerates from one command:
#
#   for arm in proof/captures/x11 proof/captures/x11/before; do
#     ffmpeg -y -i "$arm/first-frame.mp4" -vf crop=1600:300:0:700 \
#       "$arm/first-frame-composer-band.mp4"
#   done
#
# The band is the crop and not a preference. The welcome hero draws a tip
# picked at random on every launch, so two full-screen arms differ by the
# change and by whichever tip each one drew, and a pair that differs for an
# unrelated reason is not a pair. The band holds the rows the change is about
# and nothing that varies between launches.
#
# `startup.quiet` would remove the hero and the tip with it, and it is the
# wrong instrument: quiet startup skips the work whose duration the blank
# window is made of, and measured here it shrank the window from about a third
# of a second to two frames. An arm that no longer contains the transition is
# not an arm of this pair.
#
# The motion floor is zero here and nowhere else. The gate measures unique
# frames per second across the whole take and exists to catch a capture that
# stuttered; this take is a one-second transition inside a session that is
# still by design, so its rate of change is legitimately near zero and the
# default floor of 12 rejects a correct recording. The take still has to show
# the transition, which is what the two bracketing stills check.
#
# The before arm holds the changed files at the base commit for the length of
# the run. Both arms type the same line at the same rate into the same window,
# so the only difference between them is the change.
#
# WHAT IT DOES NOT SHOW. One launch on one machine at one window size. A first
# frame that only regresses under a slow disk, a cold module cache or a profile
# with more startup work than the seeded one is outside it, and so is any part
# of startup that finishes before the shell hands off.

# The launch line is typed, and a doubled character in it starts nothing at all:
# a shell scene has no model latency to hide behind, so it types at the slower
# rate the install row settled on rather than the default.
TYPE_DELAY="${TYPE_DELAY:-70}"

# The shell's own prompt has to be on screen before anything is typed, or the
# launch line lands in a terminal that is still starting and the clip opens
# mid-command.
settle 4
shot shell

# The subject starts here. Everything from this point to the prompt is the
# handover the pair is about.
submit "bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b"

# The still that matters is taken in the window between the command and the
# prompt, so it is a short pause rather than a settle: `settle` waits for the
# screen to stop changing, which is the end of the very transition this shot
# is of. `shot` aborts the take when a frame is byte-identical to the one
# before it, so a launch that drew nothing cannot be published as a recording
# of one.
pause 0.8
shot launching

# No still is taken here. On the after arm the composer is already on screen at
# the shot above, so a second frame of it is byte-identical and `shot` ends the
# take; that identity is the change, not a fault in the scene. The guard still
# runs, because an arm where the prompt never arrives is not an arm.
expect_screen "ask anything" 60

# The composer has to be reachable, not merely painted: a static frame that the
# real zone never took over would look identical in a still and accept nothing.
# Typed, not sent, so the scene needs no model.
t "hello"
settle 3
shot accepted
