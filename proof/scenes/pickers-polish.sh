#!/usr/bin/env bash
# Stills of the bare-command pickers: usage hints and descriptions at full
# width, one key legend in the footer, and the footer while a filter is live.

export SCENE_MOTION_FLOOR=0

view() { # view <shot-name> <command> [settle]
	slash "$2"
	settle "${3:-3}"
	shot "$1"
	k Escape
	settle 1
}

settle 18

view usage "/usage"
view account "/account"
view permissions "/permissions"
view memory "/memory"
view mcp "/mcp"
view advisor "/advisor"
view session "/session"
view debug "/debug"

slash "/mcp"
settle 3
t "smith"
settle 1
shot mcp-filtered
k Escape
settle 1
k Escape
settle 1
