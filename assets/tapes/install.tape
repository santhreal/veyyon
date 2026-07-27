# VHS tape for Veyyon installation and setup flow
# Regenerate: vhs assets/tapes/install.tape

Set Shell bash
Set FontSize 20
Set Width 1400
Set Height 800
Set Padding 30
Set Margin 40
Set MarginFill "#000000"
Set BorderRadius 0
Set Framerate 30
Set TypingSpeed 45ms
Set CursorBlink false
Set Theme { "name": "veyyon", "black": "#000000", "background": "#000000", "foreground": "#C6CBD4", "cursor": "#F0862E" }

Type "bash scripts/install.sh --local"
Enter
Sleep 6s


Type "vey setup status"
Enter
Sleep 4s

# Step 3 of the installer's own closing advice, so the recording shows a new user
# the path the installer just told them to take.
Type "vey --help"
Enter
Sleep 4s

Type "vey --version"
Enter
Sleep 4s
