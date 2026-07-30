# Veyyon per-agent nested spawn depth settings in one persisted state.
#
# Do not run this tape directly. Run its driver, which seeds the designer agent
# with inheritance and an explicit two-level override in the isolated demo
# profile, records both states, then restores the empty agent table:
#   bash scripts/demos/record-subagent-recursion-settings.sh
#
# The differential proves that subagent.agents.designer.maxNestedSpawnDepth is
# loaded from persistent settings and rendered by the real per-agent editor.
# Settings navigation makes no model call, so this recording is fully offline.

Output assets/.subagent-recursion-settings-shot.gif

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

Env VEYYON_DEMO_CWD "/tmp/veyyon-subagent-recursion-demo"

Hide
Type "mkdir -p /tmp/veyyon-subagent-recursion-demo && clear" Enter
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
Type "Which agent types"
Sleep 1200ms
Enter
Sleep 1500ms
Enter
Sleep 1200ms
Down
Down
Down
Enter
Sleep 1200ms

Screenshot assets/.subagent-recursion-settings-shot.png
Sleep 600ms
