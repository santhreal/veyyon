# Veyyon secret-boundary demo: a fabricated project credential is stored from
# the environment, shown to Gemini only as a placeholder, expanded for one real
# bash call, and recorded by the operator-visible use log without revealing it.
# Regenerate: `bash scripts/demos/record-secret-boundary.sh`.
# Do not run this tape directly. The driver owns the throwaway project and value.

Output assets/demo-secret-boundary.gif

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
Sleep 4s
Type "/secret add DEMO_API_TOKEN --from-env VEYYON_DEMO_SECRET --scope project"
Sleep 700ms
Escape
Enter
Sleep 3s
Type "/clear" Enter
Sleep 2s
Show

Type "/secret list"
Sleep 700ms
Escape
Enter
Sleep 4s

Type "use bash with the DEMO_API_TOKEN placeholder to print only its byte length. After the tool returns, reply exactly: The byte length is 39 bytes. Do not repeat the placeholder, credential name, or value."
Sleep 800ms
Enter
Sleep 90s

Type "/secret log --limit 5"
Sleep 700ms
Escape
Enter
Sleep 5s
