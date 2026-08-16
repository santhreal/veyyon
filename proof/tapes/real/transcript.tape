# The transcript: a real turn from the local model, then a /btw side question.
# This is the surface the rail work changed, recorded in a real terminal.
Output "/out/transcript.gif"
Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 15
Set Width 1500
Set Height 900
Set Padding 14
Set Framerate 24
Set Theme { "background": "#1e2127", "foreground": "#d7dae0" }

Hide
Type "cd /sandbox/home/demo && export LOCAL_LLM_KEY=none"
Enter
Type "bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b"
Enter
Sleep 20s
Show
Sleep 1s
Type "read src/parser.ts and say in one sentence what it rejects"
Sleep 400ms
Enter
Sleep 150s
Screenshot "/out/transcript-answer.png"
Sleep 3s
Type "/btw keep answers to one sentence"
Sleep 1s
Enter
Sleep 6s
Screenshot "/out/transcript-btw.png"
Sleep 2s
