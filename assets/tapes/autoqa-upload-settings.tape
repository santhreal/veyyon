# Veyyon Auto QA upload settings, filtered to "grievance", in one state.
#
# Do not run this tape directly. Run its driver, which seeds `dev.autoqa` off
# and on in the isolated demo profile, records both states, and restores it off:
#   bash scripts/demos/record-autoqa-upload-settings.sh
#
# The differential proves the network controls are hidden while local Auto QA
# recording is off and appear only after the master setting is enabled.
# Settings navigation makes no model call, so this recording is fully offline.

Output assets/.autoqa-upload-settings-shot.gif

Set Shell "bash"
Set FontSize 22
Set Width 1400
Set Height 800
Set Padding 30
Set Margin 40
Set MarginFill "#000000"
Set BorderRadius 0
Set Framerate 30
Set TypingSpeed 55ms
Set CursorBlink false
Set Theme {"name":"veyyon","black":"#000000","background":"#000000","foreground":"#C6CBD4","cursor":"#F0862E"}

Env VEYYON_DEMO_CWD "/tmp/veyyon-autoqa-demo"

Hide
Type "mkdir -p /tmp/veyyon-autoqa-demo && clear" Enter
Sleep 300ms
Type "bash scripts/demos/launch.sh" Enter
Sleep 3s
Show

Type "/settings"
Sleep 700ms
Enter
Sleep 1200ms
Type "/"
Sleep 400ms
Type "grievance"
Sleep 2000ms

Screenshot assets/.autoqa-upload-settings-shot.png
Sleep 600ms
