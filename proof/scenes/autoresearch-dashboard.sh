#!/usr/bin/env bash
# The autoresearch dashboard: the collapsed widget over the composer, and the
# full-screen overlay behind alt+x.
#
# Needs SCENE_SEED_AUTORESEARCH=1, which writes one session and six logged runs
# through the product's own storage API before veyyon starts. The dashboard then
# reads real rows: a baseline, two kept improvements, a crash, a run whose checks
# failed, and a flagged run whose metric moved because work left the timed
# region. That spread is deliberate, so every status the dashboard renders is on
# screen rather than the happy one.
#
# `/autoresearch` with no argument on a branch that already has a session resumes
# it, which is what puts the widget up without spending a model turn on it.

settle 20

# Resume the seeded session. This sends a message, so the take waits for the
# widget rather than for the model.
slash "/autoresearch"
settle 6

# INTERRUPT THE RESUMED TURN BEFORE TOUCHING THE OVERLAY. The scene model is a
# 1.5B local one and the resume prompt keeps it busy well past the end of the
# take, so every frame after this point carried a spinner and a growing timer,
# and two stills that differ only in that timer are two stills of the same state.
k Escape
settle 4
shot collapsed

# The overlay: the table, the scrollbar and the footer.
k alt+x
settle 4
shot overlay

# NO SCROLLED SHOT. The seeded segment is five rows and the overlay viewport is
# thirty-two, so Down moves nothing and the frame is the byte-identical twin of
# the one above it, which aborts the take. A scroll frame belongs to a scene that
# seeds more rows than fit.

k Escape
settle 3
shot closed
