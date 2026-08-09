# Veyyon secret-boundary demo: a fabricated credential is stored from the
# environment, listed as a placeholder only, expanded for one real bash call,
# and recorded in the expansion log without its value.
# In a terminal everything after `/secret` is the credential itself, so the
# hidden seed uses the one flag that grammar keeps, `--from-env`, and answers
# the visible name field that follows it. `list` and `log` are reserved words,
# so they run as commands rather than being stored.
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
Type "/secret --from-env VEYYON_DEMO_SECRET"
Sleep 700ms
Escape
Enter
Sleep 2s
Type "DEMO_API_TOKEN"
Sleep 500ms
Enter
Sleep 3s
Type "/clear" Enter
Sleep 2s
Show

Type "/secret list"
Sleep 700ms
Escape
Enter
Sleep 5s

Type "use bash with the DEMO_API_TOKEN placeholder to print only its byte length. After the tool returns, reply exactly: The byte length is 39 bytes. Do not repeat the placeholder, credential name, or value."
Sleep 800ms
Enter
Sleep 90s

Type "/secret log"
Sleep 700ms
Escape
Enter
Sleep 6s
