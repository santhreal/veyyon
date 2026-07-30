# Model-native effort variants and direct model-chain position editing.
# Both commands construct the shipped settings components, not text mock-ups.
# Regenerate from the repository root: `bash scripts/demos/record.sh model-effort-controls`.

Output assets/model-effort-controls.gif

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
Sleep 200ms
Show
Type "bun scripts/demos/render-effort-variants.ts --width 100" Enter
Sleep 3s
Type "clear" Enter
Sleep 400ms
Type "bun scripts/demos/render-model-chain-editor.ts --width 100" Enter
Sleep 4s
