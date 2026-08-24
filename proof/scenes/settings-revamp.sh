#!/usr/bin/env bash
# /settings driven by keys alone: the selected row's inline description, a
# drill-down owning the whole card, and the search banner over the renamed
# labels. No pointer: a glide cannot run on every recorder host, and every
# change this scene proves is reachable from the keyboard.
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

# Search crosses tabs; the Auth Broker rows carry empty value cells.
t "/auth broker"
settle 2
shot search-auth
k Escape
settle 1
