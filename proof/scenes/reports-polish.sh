#!/usr/bin/env bash
# Record reports printed by slash commands: /tools, /hotkeys, /context, /jobs, /todo, /lsp, /changelog, /plugins, /effort
export SCENE_MOTION_FLOOR=0

view() { # view <shot-name> <command> [settle]
	slash "$2"
	settle "${3:-3}"
	shot "$1"
	k Escape
	settle 1
}

settle 10
shot idle

view tools "/tools"
view hotkeys "/hotkeys"
view context "/context"
view jobs "/jobs"
view todo "/todo"
view lsp "/lsp"
view changelog "/changelog"
view plugins "/plugins"
view effort "/effort"
