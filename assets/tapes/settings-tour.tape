# Veyyon settings tour: every production settings category, the real category
# sidebar, search, conditional sections, and source-aware Default Model row.
# Regenerate from the repository root: `bash scripts/demos/record.sh settings-tour`.
# Uses the isolated demo profile. Settings navigation itself is offline.

Output assets/demo-settings-tour.gif

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
Sleep 4s
Show
Type "/settings"
Sleep 900ms
Enter
Sleep 4s

# Move focus to the sidebar and visit every remaining category in registry order.
Left
Sleep 700ms
Down
Sleep 1100ms
Down
Sleep 1100ms
Down
Sleep 1100ms
Down
Sleep 1100ms
Down
Sleep 1100ms
Down
Sleep 1100ms
Down
Sleep 1100ms
Down
Sleep 1100ms
Down
Sleep 1100ms
Down
Sleep 1100ms
Down
Sleep 1100ms
Down
Sleep 1100ms

# Search across categories and end on the saved-vs-active model ownership proof.
Right
Type "/"
Sleep 500ms
Type "default model"
Sleep 5s
