#!/usr/bin/env bash
# Stills of every surface outside the transcript: the settings panel and its
# submenus, the pickers, and the slash commands that print a report.

export SCENE_MOTION_FLOOR=0

view() { # view <shot-name> <command> [settle]
	slash "$2"
	settle "${3:-3}"
	shot "$1"
	k Escape
	settle 1
}

settle 18
shot idle

submit "/settings"
settle 3
shot settings-appearance
k Down
settle 1
k Down
settle 1
shot settings-row-light-theme
k Return
settle 2
shot settings-submenu-light-theme
k Escape
settle 1
k Left
settle 1
k Down
settle 1
k Right
settle 2
shot settings-model
k Left
k Down
settle 1
k Right
settle 2
shot settings-interaction
k Left
k Down
k Down
k Down
settle 1
k Right
settle 2
shot settings-context
k Left
k Down
k Down
k Down
k Down
k Down
k Down
k Down
k Down
k Down
settle 1
k Right
settle 2
shot settings-tools
k Escape
settle 2
k Escape
settle 2

view model "/model"
view usage "/usage"
view hotkeys "/hotkeys"
view tools "/tools"
view context "/context"
view session "/session"
view jobs "/jobs"
view extensions "/extensions" 4
view agents "/agents" 4
view account "/account"
view providers "/providers"
view permissions "/permissions"
view statusline "/statusline"
view memory "/memory"
view plugins "/plugins"
view mcp "/mcp"
view profile "/profile"
view todo "/todo"
view lsp "/lsp"
view changelog "/changelog"
view resume "/resume" 4
view login "/login"
view debug "/debug"
view advisor "/advisor"
view effort "/effort"
view welcome "/welcome"
