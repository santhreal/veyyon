#!/usr/bin/env bash
# The composer footline under location pressure, in every state it can hold without a
# model turn.
#
# WHY THIS SCENE. `location` (the working directory and the git branch) and the right
# group (model identity, approval rung, subagent count, context gauge) share one line.
# When location is wide the right group is shed from its end, and which member goes first
# is a ranking, not a width. Every other fixture under proof/docker/seed-demo.sh sits
# directly in the demo project on `main` -- eleven columns of location, which never reaches
# the width where the ranking decides anything. This scene runs in the seeded
# platform-services project, whose path and branch name together are about ninety columns,
# so the shed order is visible rather than theoretical.
#
# EVERY STATE, DERIVED FROM SOURCE. The right group's `mode` segment composes three
# independent facts through one `joinStates` call: the `/yolo` bypass marker, a base mode
# from `BASE_MODE_STATES` (segments.ts:362 -- plan, prewalk, goal, vibe, loop) and an
# approval rung from `AUTONOMY_LABEL` (approval-modes.ts:81 -- Plan, Ask all, Ask cmds,
# Auto, Yolo). Twelve frames cover it: five rungs, three base modes plus a paused goal, the
# bypass over the widest base label, and a composer draft for `location_right`.
#
# A thirteenth frame is not a mode. The path clamp is a budget rather than a width, so no
# terminal is wide enough to show a long path; a click on the location text drops the model
# chip and spends its columns on the path instead.
#
# WHAT THIS TAKE DOES NOT CATCH, and why neither is reachable from a slash command:
#
#   `subagents`, rank 5 in `RIGHT_PART_SHED_RANK`. Its text is empty until a subagent is
#   actually running, so it holds no columns in any frame here.
#
#   `prewalk`, second in `BASE_MODE_STATES`. `armPrewalk` needs a resolvable fast/cheap
#   model that differs from the session's own -- it clears the state outright when the
#   target matches the current model -- and it steers the live agent to announce the
#   switch (agent-session.ts:2903-2941). Both need a model this host does not serve.
#
# The suite covers both by pinning the shed order by equality instead, so a rank that moves
# fails there even though no frame here can show it.
#
# The states differ only in what the right group contains, so they do not shed at the same
# width: a terminal that fits `Auto` does not fit `! YOLO · Plan`, and the same terminal
# proves a different thing in each state. That is why the frames are taken per state and
# the scene is run once per width rather than resizing mid-take.
#
# NO MODEL TURN. Every state is reached by a slash command, so the scene records at the
# same speed on any host and needs no weights. The context gauge reads its idle value
# throughout, which is the point: nothing here is waiting on a server.
#
# Run one arm per width, and pair it with proof/docker/record-x11-before.sh at the same
# width. 12 pixels per column in proof/docker/xsession.sh, and OUT_DIR is a docker bind
# mount, so it has to be absolute:
#
#   for px in 960 1200 1440; do            # about 80, 100 and 120 columns
#     SCENE_WIDTH=${px} SCENE_MOTION_GATE=0 \
#     SCENE_CWD=/sandbox/home/platform-services/ingest-pipeline/normalizer \
#     OUT_DIR="${PWD}/proof/captures/x11/w${px}" \
#       proof/docker/record-x11.sh proof/scenes/statusline-widths.sh
#   done
#
# SCENE_MOTION_GATE=0 because the take is thirteen stills of a status line. The motion floor
# is there to stop a published clip from encoding as a slideshow; this scene IS a
# slideshow, and the frames are the artifact.
set -euo pipefail

settle 12

# Part of the seeded project path, from proof/docker/seed-demo.sh. Its presence is how the
# scene knows SCENE_CWD arrived: without it the session opened somewhere else and every
# frame below would photograph a short location under no pressure at all.
#
# EACH ARM LOOKS AT THE END OF THE PATH THAT ARM KEEPS, and that is not fussiness. At
# seventy-eight columns the two arms share almost no path text: main clips the location at
# BOTH ends (`…orm-services/ingest-pipeline/normalize…`), so the directory the session is
# actually in is the one thing it does not show, while the branch cuts the head only and
# keeps `normalizer` whole. A needle on the tail fails main; a needle on the head fails the
# branch, which spends what main saves on a model chip it no longer sheds.
if [ "${SCENE_ARM:-after}" = "before" ]; then
	expect_screen "orm-services" 60 "seeded-cwd"
else
	expect_screen "normalizer" 60 "seeded-cwd"
fi

# ---------------------------------------------------------------------------
# THE RUNGS. `AUTONOMY_LABEL` in tools/core/approval-modes.ts is the whole set, and
# `/permissions <rung>` is the only way to reach one without restarting. They are shot
# before any mode is enabled, because `mode` renders bypass, base mode and rung through one
# `joinStates` call and a base label would put two variables in the frame at once.
# ---------------------------------------------------------------------------
shot idle

# ---------------------------------------------------------------------------
# THE PATH EXPANDED BY A CLICK, the one frame here that is not a mode. The clamp is a
# budget rather than a width, so no terminal is wide enough to show a long path; a click on
# the location text drops the model chip and gives its columns to the path.
#
# On main this click lands on a status line with no handler for it, so the before arm of
# this frame is the collapsed path. That is the differential.
#
# SHOT FIRST, AND THAT POSITION IS A FINDING. Once any confirmation dialog has opened and
# closed in a session -- `/goal drop` and `/yolo` both raise one -- the footline answers no
# click at all: three attempts on the row the text is on changed nothing, while the same
# click lands in idle, under a rung, under `/loop` and under `/plan` before any dialog has
# been shown. It takes the gauge and the secrets chip down with it, so it is the footline's
# routing rather than this expansion, and it is not this branch's to fix. The frame is
# taken where the click demonstrably works, which is before the first dialog.
#
# The click also needs the mouse: reports only arrive while the engine holds it, so this
# arm runs with `tui.scrollIsolation: true`. That is the operator's own opt-in and it is
# what the gauge has always needed too.
# ---------------------------------------------------------------------------
collapsed="$(row_with "Auto")"
click_row_with "Auto" 6
settle 2
expanded="$(row_with "Auto")"
echo "scene: footline before the click:${collapsed}" >&2
echo "scene: footline after the click: ${expanded}" >&2

# EACH ARM GUARDED ON WHAT THAT ARM MUST DO WITH THE CLICK, which is the only property both
# can be held to. The obvious assertion -- the before arm still shows the model chip -- is
# WRONG here: main sheds that chip at every width in this fixture, which is the defect this
# whole branch is about, so demanding it fails the arm for being the bug. What main must do
# is nothing at all, and what the branch must do is something.
if [ "${SCENE_ARM}" = "before" ]; then
	[ "${collapsed}" = "${expanded}" ] ||
		abandon_take "path-expanded" "main answered the click, so this arm is not photographing main"
else
	[ "${collapsed}" != "${expanded}" ] ||
		abandon_take "path-expanded" "the click changed nothing on the footline"
	case "${expanded}" in
	*Qwen2.5*) abandon_take "path-expanded" "the model chip is still on the footline after the click" ;;
	esac
fi
# NO FRAME FOR THE BEFORE ARM, because there is no state for it to photograph: main has no
# handler for the click, so the line after it is the line before it, and `shot` rejects a
# frame byte-identical to the one ahead of it. The pair for this row is the before arm's
# idle frame, which is the same driver, width and settings -- an unchanged footline is
# precisely what main does with the click.
if [ "${SCENE_ARM:-after}" != "before" ]; then
	shot path-expanded
fi

# Collapse it again, so every frame below photographs the ordinary footline rather than an
# expansion left switched on. The after arm needs the click; the before arm has no handler
# and nothing to undo.
if [ "${SCENE_ARM:-after}" != "before" ]; then
	click_row_with "Auto" 6
	settle 2
fi

slash "/permissions ask"
expect_screen "Ask all" 30 "rung-ask"
shot rung-ask-all

slash "/permissions ask-command"
expect_screen "Ask cmds" 30 "rung-ask-command"
shot rung-ask-cmds

# THE RUNG NOBODY CAN SEE ANOTHER WAY. `/permissions plan` sets the plan rung with no plan
# session open: `renderBaseMode` says nothing and the rung is the only thing naming a state
# where every write tool is denied. segments.ts:431-437 exists because that pair once
# rendered as an empty segment.
slash "/permissions plan"
expect_screen "Plan" 30 "rung-plan"
shot rung-plan

# The configured rung reading `Yolo`, which is NOT the `! YOLO` bypass marker below: one is
# a saved preference, the other is this session overriding it. They render differently on
# purpose and the pair is the only place that is visible.
slash "/permissions yolo"
expect_screen "Yolo" 30 "rung-yolo"
shot rung-yolo

slash "/permissions reset"
expect_screen "Auto" 30 "rung-reset"

# ---------------------------------------------------------------------------
# THE BASE MODES. `renderBaseMode` returns the FIRST non-empty entry of
# `BASE_MODE_STATES` (plan > prewalk > goal > vibe > loop), so only one label is ever on
# the line and the order here is chosen so each frame holds the one it is named after.
#
# THE ORDER IS FORCED BY THE MODES' OWN EXCLUSIONS, not by rendering priority. Plan, vibe
# and goal are PAIRWISE exclusive -- each of the three refuses to start while either other
# one is enabled or paused (interactive-mode.ts:2863-2868, 3034-3041, 3628-3634) -- while
# `loop` and `prewalk` have no such guard. Of the three, only `/vibe` is a plain toggle:
# leaving goal mode goes through a confirm dialog. So vibe is shot and toggled off first,
# goal second, and plan last, after the dialog has been answered.
#
# Two orders that read as safe and are not: ascending rendering priority puts vibe before
# goal, and the goal command then warns "Exit vibe mode first" while the guard waits out
# its whole ceiling; and dropping the goal without answering the dialog leaves it PAUSED,
# which blocks vibe and plan exactly as an enabled one does.
#
# Each frame's guard is what catches a mode that did not exit: the take abandons on the
# label rather than shooting a frame named for a state that is not on screen.
# ---------------------------------------------------------------------------
slash "/loop"
expect_screen "Loop" 30 "mode-loop"
shot mode-loop
slash "/loop"
settle 2

slash "/vibe"
expect_screen "Vibe" 30 "mode-vibe"
shot mode-vibe
slash "/vibe"
settle 2

# GOAL MODE NEEDS AN OBJECTIVE, NOT A TURN. Bare `/goal` opens the objective editor and
# enables nothing, which is why a guard on the chip waited out its whole ceiling here.
# `/goal set <objective>` runs `#enterGoalMode` BEFORE it hands the objective to the
# submit path (interactive-mode.ts:3909-3912), so the chip is on the line as soon as the
# command returns. The submission that follows needs a model and does not resolve on this
# host; the frame is taken on the chip, and the paused frame below is the state that
# outlives the attempt.
slash "/goal set keep the ingest normalizer failing closed on a malformed record"
expect_screen "Goal" 60 "mode-goal"
shot mode-goal

# PAUSED, which is a different render and not a dimmer one: `renderGoalMode` recolors to
# warning and appends the pause suffix. It is also the state a reader of this pair can
# reach by hand, since the running one depends on a model answering.
slash "/goal pause"
settle 3
shot mode-goal-paused

# The confirm dialog from `#confirmAndDropGoal`; Return answers it. Plan mode refuses while
# a goal is enabled OR paused, so this is what makes the next frame reachable.
slash "/goal drop"
pause 0.5
k Return
settle 3

# PLAN ALONE, where the rung is suppressed rather than shed: the base label already says
# Plan and `Plan Plan` is what the suppression at segments.ts:437 prevents. Every other
# frame in this take carries a rung, so this is the one that proves the suppression.
slash "/plan"
expect_screen "Plan" 30 "mode-plan"
shot mode-plan

# ---------------------------------------------------------------------------
# THE BYPASS, on top of the widest base label. This is the widest the right group ever
# gets: two states in `mode` where every other frame has one.
# ---------------------------------------------------------------------------
slash "/yolo"
pause 0.5
# The confirmation dialog owns Return; the second one answers "Yes".
k Return
expect_screen "YOLO" 30 "bypass"
shot plan-and-yolo

# A DRAFT IN THE COMPOSER puts the token readout into `location_right`, the zone that is
# pushed last and shed first without a rank. Typed, not submitted: the readout is a
# property of the draft, and submitting it would need a model.
clear_composer
t "rewrite the ingest normalizer so a malformed record fails closed instead of coercing"
settle 2
shot draft