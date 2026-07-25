# Interactive rollback picker — one ground.
#
# `/rollback` opens the searchable version picker over the transcript. This tape
# launches veyyon, opens the picker, and screenshots it. The version list is
# read from a local fixture registry (VEYYON_NPM_REGISTRY) the driver serves, so
# the shot is deterministic and offline. The ground/theme and output path are
# templated by the driver (scripts/demos/record-rollback-ui.sh). Do not run
# directly.

Output "__OUT_GIF__"

Set Shell bash
Set FontSize 22
Set Width 1400
Set Height 820
Set Padding 30
Set Margin 40
Set MarginFill "__GROUND__"
Set BorderRadius 0
Set Framerate 30
Set CursorBlink false
Set Theme { "name": "veyyon", "black": "__GROUND__", "background": "__GROUND__", "foreground": "__FG__", "cursor": "#F0862E" }

Env VEYYON_DEMO_CWD "/tmp/veyyon-rollback-demo"
Env VEYYON_NPM_REGISTRY "http://127.0.0.1:4873"

Hide
Type "mkdir -p /tmp/veyyon-rollback-demo && clear" Enter
Sleep 300ms
Type "bash scripts/demos/launch.sh" Enter
Sleep 4500ms
Show
Type "/rollback"
Sleep 700ms
Enter
Sleep 2500ms
Screenshot "__OUT_PNG__"
Sleep 400ms
