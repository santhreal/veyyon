# Veyyon plan-mode demo: plan mode explores read-only and drafts a plan file,
# holding mutation until you resolve it.
# Regenerate from the repository root: `bash scripts/demos/record.sh plan`.

Output assets/demo-plan.gif

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
Type "bash scripts/demos/launch.sh" Enter
Sleep 3s
Show

Type "/plan"
Sleep 1200ms
Enter
Sleep 1500ms
Type "plan a sliding-window limiter alongside the token bucket; inspect only src/rate-limiter.ts and src/rate-limiter.test.ts, do not use subagents"
Sleep 800ms
Enter
Sleep 120s
