#!/usr/bin/env bash
# Stills of misc dialogs: extensions, agents, account, providers, profile, resume, login.

export SCENE_MOTION_FLOOR=0

view() { # view <shot-name> <command> [settle]
	slash "$2"
	settle "${3:-3}"
	shot "$1"
	k Escape
	settle 1
}

settle 18

view extensions "/extensions" 4
view agents "/agents" 4
view account "/account"
view providers "/providers"
view profile "/profile"
view resume "/resume" 4
view login "/login"
