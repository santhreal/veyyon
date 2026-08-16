#!/usr/bin/env bash
# Not a proof scene: a stopwatch on the scene DSL itself.
#
# The card-bands recording came back at 351s for a scene whose own sleeps add up
# to about sixty, and both arms came back at the same 351s, so the overrun is
# deterministic and belongs to a helper rather than to load. This times each one
# against the same app the real scenes drive and prints the cost per call.

_t() { date +%s%N; }
_report() { echo "TIMING $1: $(((($(_t) - $2)) / 1000000))ms"; }

s=$(_t); settle 3; _report "settle 3" "$s"
s=$(_t); submit "/model"; _report "submit /model" "$s"
s=$(_t); settle 5; _report "settle 5" "$s"

s=$(_t); point 11 45; _report "point 11 45 (first)" "$s"
s=$(_t); point 14 45; _report "point 14 45" "$s"
s=$(_t); point 14 45; _report "point 14 45 (repeat, same cell)" "$s"
s=$(_t); point 11 45; _report "point 11 45" "$s"
s=$(_t); glide 11 45 14 45 12 0.10; _report "glide 12 steps" "$s"
s=$(_t); k Escape; _report "k Escape" "$s"
settle 2
