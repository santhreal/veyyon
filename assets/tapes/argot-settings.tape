# Veyyon Argot settings screen, filtered to "argot", in one state.
#
# This tape captures a SINGLE state of the settings screen and writes it to
# assets/.argot-settings-shot.png. The state (argot on or off) is seeded from
# the shell BEFORE vhs runs, with `veyyon config set argot.enabled`, so the
# screenshot never depends on a TUI toggle keybinding landing right.
#
# Do not run this tape directly. Run its driver, which seeds each state and
# moves the shot into place, producing the disabled-vs-enabled differential:
#   bash scripts/demos/record-argot-settings.sh
# The driver writes assets/argot-settings-off.png (only the master toggle) and
# assets/argot-settings-on.png (the master toggle plus its four dependent
# knobs), and restores argot to off. The contrast is the proof: an experimental
# feature that is off hides its knobs completely.
#
# Settings navigation makes no model call, so this records fully offline.

Output assets/.argot-settings-shot.gif

Set Shell bash
Set FontSize 22
Set Width 1400
Set Height 720
Set Padding 30
Set Margin 40
Set MarginFill "#000000"
Set BorderRadius 0
Set Framerate 30
Set TypingSpeed 55ms
Set CursorBlink false
Set Theme { "name": "veyyon", "black": "#000000", "background": "#000000", "foreground": "#C6CBD4", "cursor": "#F0862E" }

Env VEYYON_DEMO_CWD "/tmp/veyyon-argot-demo"

Hide
Type "mkdir -p /tmp/veyyon-argot-demo && clear" Enter
Sleep 300ms
Type "bash scripts/demos/launch.sh" Enter
Sleep 3s
Show

# Open settings and filter to the Argot group.
Type "/settings"
Sleep 700ms
Enter
Sleep 1200ms
Type "/"
Sleep 400ms
Type "argot"
Sleep 2000ms

Screenshot assets/.argot-settings-shot.png
Sleep 600ms
