# Model-native effort variants and direct model-chain position editing.
# Both commands construct the shipped settings components, not text mock-ups.

Output assets/model-effort-controls.gif

Set Shell bash
Set FontSize 20
Set Width 1900
Set Height 980
Set Padding 24
Set Margin 32
Set MarginFill "#1e2127"
Set BorderRadius 0
Set Framerate 24
Set TypingSpeed 35ms
Set CursorBlink false
Set Theme { "name": "veyyon", "black": "#000000", "background": "#1e2127", "foreground": "#C6CBD4", "cursor": "#F0862E" }

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
