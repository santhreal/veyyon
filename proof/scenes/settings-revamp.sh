#!/usr/bin/env bash
# Settings UX revamp scene: Appearance, Model, Interaction, Rules, Global, and submenu

export SCENE_MOTION_FLOOR=0

settle 18
shot idle

submit "/settings"
settle 3
shot settings-appearance

# Navigate to Symbol Preset (row 2: Dark Theme, Light Theme, Symbol Preset)
k Down
settle 1
k Down
settle 1
k Return
settle 2
shot settings-submenu
k Escape
settle 1

# Move to Model tab
k Left
settle 1
k Down
settle 1
k Right
settle 2
shot settings-model

# Move to Interaction tab
k Left
settle 1
k Down
settle 1
k Right
settle 2
shot settings-interaction

# Move to Rules tab (down: Resources, Context, Rules)
k Left
settle 1
k Down
k Down
k Down
settle 1
k Right
settle 2
shot settings-rules

# Move to Global tab (down: Memory, Files, Shell, Tools, Tasks, Agents, Providers, Experimental, Global)
k Left
settle 1
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
shot settings-global

k Escape
settle 2
k Escape
settle 2
