# Veyyon edit demo: a hashline edit landing (read, anchored diff, verified write).
# Regenerate: from the repo root, run `vhs assets/tapes/edit.tape`.
# --auto-approve so the write lands without a prompt interrupting the capture.

Output assets/demo-edit.gif

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

Hide
Type "clear" Enter
Sleep 300ms
Type "bash scripts/demos/launch.sh --auto-approve" Enter
Sleep 3s
Show

Type "add a clamp(n, lo, hi) helper to src/utils.ts"
Sleep 800ms
Enter
Sleep 16s
