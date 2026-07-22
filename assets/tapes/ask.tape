# Veyyon ask demo: read a file, answer grounded in the source.
# Regenerate: from the repo root, run `vhs assets/tapes/ask.tape`.

Output assets/demo-ask.gif

Set Shell bash
Set FontSize 22
Set Width 1400
Set Height 560
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
Type "bash scripts/demos/launch.sh" Enter
Sleep 3s
Show

Type "what does the RateLimiter in src/rate-limiter.ts do?"
Sleep 800ms
Enter
Sleep 11s
