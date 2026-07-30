# Version picker proof, titanium on the brand's black ground.
# Regenerate from the repository root: `bash scripts/demos/record.sh rollback-picker`.
#
# It renders the shipped component against fixed rows rather than driving
# `veyyon rollback`, because the live command reads the release list over the
# network: the frame would change with whatever is published that day, and it
# would show an error rather than a picker on an offline machine. Neither is a
# repeatable image.

Output proof/rollback-picker/picker-titanium-black.png

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

Hide
Type "clear" Enter
Sleep 300ms
Type "bun scripts/demos/render-rollback-picker.ts --theme titanium --width 100" Enter
Sleep 4s
Show
Sleep 500ms
Screenshot proof/rollback-picker/picker-titanium-black.png
