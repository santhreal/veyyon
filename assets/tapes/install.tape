# Veyyon installer demo: a real release binary installed into a throwaway HOME,
# followed by the installed binary's help and version output.
# Regenerate: `bash scripts/demos/record-install.sh`.
# Do not run this tape directly. The driver owns the isolated destination.

Output assets/install-demo.gif

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

Type "bash scripts/install.sh --binary" Enter
Sleep 12s

Type "$VEYYON_INSTALL_DIR/veyyon --help" Enter
Sleep 4s

Type "$VEYYON_INSTALL_DIR/veyyon --version" Enter
Sleep 4s
