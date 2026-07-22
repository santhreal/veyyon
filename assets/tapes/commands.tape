# Veyyon commands demo: the slash-command palette, filtering live.
# Regenerate: from the repo root, run `vhs assets/tapes/commands.tape`.

Output assets/demo-commands.gif

Set Shell bash
Set FontSize 22
Set Width 1400
Set Height 560
Set Padding 30
Set Margin 40
Set MarginFill "#000000"
Set BorderRadius 0
Set Framerate 30
Set TypingSpeed 90ms
Set CursorBlink false
Set Theme { "name": "veyyon", "black": "#000000", "background": "#000000", "foreground": "#C6CBD4", "cursor": "#F0862E" }

Hide
Type "clear" Enter
Sleep 300ms
Type "bash scripts/demos/launch.sh" Enter
Sleep 3s
Show

Type "/"
Sleep 1600ms
Type "model"
Sleep 2500ms
