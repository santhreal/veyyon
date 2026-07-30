# Setup wizard subagent selector, default-vs-specialists differential.
#
# Regenerate with:
#   bash scripts/demos/record-setup-subagents.sh
#
# The tape renders the real setup scene under the isolated demo profile. The
# first state keeps only task enabled. The second enables the read-only scout
# and reviewer roles as well. No model request is made.

Output assets/setup-subagents.gif

Set Shell "bash"
Set FontSize 22
Set Width 1600
Set Height 900
Set Padding 30
Set Margin 40
Set MarginFill "#000000"
Set BorderRadius 0
Set Framerate 30
Set TypingSpeed 45ms
Set CursorBlink false
Set Theme {"name":"veyyon","black":"#000000","background":"#000000","foreground":"#C6CBD4","cursor":"#F0862E"}

Hide
Type "clear && VEYYON_PROFILE=demo bun scripts/demos/render-setup-subagents.ts --enabled task" Enter
Sleep 800ms
Show
Screenshot assets/.setup-subagents-default.png
Sleep 900ms

Hide
Type "clear && VEYYON_PROFILE=demo bun scripts/demos/render-setup-subagents.ts --enabled task,reviewer,scout" Enter
Sleep 800ms
Show
Screenshot assets/.setup-subagents-specialists.png
Sleep 1200ms
