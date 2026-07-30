# Veyyon LSP refactor demo: Gemini performs a symbol-aware cross-file rename,
# applies the server's edits, and runs the real fixture tests before reporting.
# Regenerate from the repository root: `bash scripts/demos/record.sh lsp-refactor`.
# Uses the isolated demo profile and Gemini 3.6 Flash high.

Output assets/demo-lsp-refactor.gif

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
Type "bash scripts/demos/launch.sh --auto-approve" Enter
Sleep 3s
Show

Type "rename the exported RateLimiter symbol to TokenBucket using the language server, update every reference, then run the complete fixture test suite"
Sleep 900ms
Enter
Sleep 90s
