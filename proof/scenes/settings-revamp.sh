#!/usr/bin/env bash
# /settings driven by keys alone, one shot per visible change: the selected row's
# inline description, a drill-down owning the whole card, phrase-coherent search
# ranking, an ellipsis-marked clipped value, a named duration, renamed labels and
# the unset-value dash. No pointer: a glide cannot run on every recorder host,
# and every change this scene proves is reachable from the keyboard.
settle 20
slash "/settings"
settle 4
shot open

# The theme picker is a drill-down: it owns the card while open.
k Return
settle 2
shot theme-picker
k Escape
settle 1

# Search ranks the label that IS the typed phrase first.
t "compaction model"
settle 2
shot search-ranking
k Escape
settle 1

# A clipped value carries the ellipsis marker.
t "web ui url"
settle 2
shot truncation-ellipsis
k Escape
settle 1

# A duration reads as a duration, not a millisecond count.
t "exa search delay"
settle 2
shot exa-duration
k Escape
settle 1

# The master toggle names what it switches.
t "ttsr"
settle 2
shot labels-ttsr
k Escape
settle 1

# Empty value cells are marked, and the description rides the selection.
t "auth broker"
settle 2
shot search-auth
k Escape
settle 1
