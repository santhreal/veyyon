# Post-update tip-slot hint — one state, one ground.
#
# The welcome home shows a one-shot hint in the tip slot on the first launch
# after an upgrade. This tape seeds the "just updated" state from the shell
# (writing an OLDER version into the last-changelog marker so decideUpdateNotice
# fires) and screenshots the home hero. The ground/theme and output path are
# templated by the driver (scripts/demos/record-rollback-ui.sh), which records
# the same tape across the titanium/black, light/white, and titanium/grey
# matrix. Do not run directly.

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
Type "mkdir -p /tmp/veyyon-rollback-demo && printf '1.0.11' > /home/mukund-thiru/.veyyon/profiles/work/agent/last-changelog-version && clear" Enter
Sleep 300ms
Type "bash scripts/demos/launch.sh" Enter
Sleep 4500ms
Show
Sleep 600ms
Screenshot "__OUT_PNG__"
Sleep 400ms
