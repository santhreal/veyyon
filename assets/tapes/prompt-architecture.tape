# Veyyon prompt architecture demo: the shipped statement registry and assembled sections.
# Regenerate from the repository root: `bash scripts/demos/record.sh prompt-architecture`.
# This uses the isolated demo profile and the same Gemini 3.6 Flash high model
# contract as live workflow tapes. It inspects the real production prompt builder.

Output assets/demo-prompt-architecture.gif

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
Show
Type "bun packages/coding-agent/src/cli.ts --profile demo prompt --sections --cwd $HOME/orbit" Enter
Sleep 4s
Type "bun packages/coding-agent/src/cli.ts --profile demo prompt --statements --cwd $HOME/orbit" Enter
Sleep 15s
