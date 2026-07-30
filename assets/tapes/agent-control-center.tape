# Veyyon Agent Control Center demo: two real workers fan out in parallel.
# Their live states, assigned models, effort, and lifecycle controls remain visible.
# Regenerate from the repository root: `bash scripts/demos/record.sh agent-control-center`.
# Uses the isolated demo profile and Gemini 3.6 Flash high.

Output assets/demo-agent-control-center.gif

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

Type "use two task agents in parallel: one inspect src/rate-limiter.ts and one inspect src/rate-limiter.test.ts; require each worker to send one concise observation to the other through irc before both return; do not edit"
Sleep 900ms
Enter
Sleep 90s

Type "/agents"
Sleep 900ms
Enter
Sleep 6s
