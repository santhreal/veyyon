# Veyyon compaction demo: real context growth, manual lossless-first compaction,
# and the post-compaction context report in one production session.
# Regenerate from the repository root: `bash scripts/demos/record.sh context-compaction`.
# Uses the isolated demo profile and Gemini 3.6 Flash high.

Output assets/demo-context-compaction.gif

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

Type "read every file under src, compare the rate limiter implementation with its tests, and explain the exact boundary behavior; do not edit"
Sleep 900ms
Enter
Sleep 30s

Type "/context"
Sleep 700ms
Enter
Sleep 3s

Type "/compact"
Sleep 700ms
Enter
Sleep 35s

Type "/context"
Sleep 700ms
Enter
Sleep 5s
