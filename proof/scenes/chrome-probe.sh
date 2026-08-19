#!/usr/bin/env bash
# WHY THIS EXISTS. The chrome is a compositor setting, and a compositor setting cannot be
# reviewed from the flag that sets it: picom will start, redirect the screen and report
# success while producing something that looks nothing like what was intended. The only
# review that means anything is the frame itself, and a frame on its own proves nothing
# either, because "is this frost stronger" has no answer without the arm it replaced.
#
# So this scene exists to be run twice against the same surface with one setting changed,
# and it is the smallest scene that can be: bring the app up, let it settle, take one frame.
# Nothing is typed and no turn is driven, because a model turn would put different text on
# screen in each arm and the difference under review is the glass, not the transcript.
#
# It does not source lib.sh. xsession.sh sources the library and then sources the scene, so
# a scene that sources it again resolves the path against the wrong directory and dies on
# line one -- which is how the first attempt at this probe recorded five minutes of nothing.
settle 8
shot chrome
