# Smoke: the real binary, in a real terminal, answering a real local model.
Output "/out/smoke.gif"
Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 15
Set Width 1500
Set Height 800
Set Padding 14
Set Framerate 24
Set Theme { "background": "#1e2127", "foreground": "#d7dae0" }

Hide
Type "cd /sandbox/home/demo && export LOCAL_LLM_KEY=none"
Enter
Type "bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b"
Enter
Sleep 15s
Show
Sleep 2s
Type "why does the parser reject an empty focus string?"
Sleep 500ms
Enter
Sleep 75s
Screenshot "/out/smoke.png"
Sleep 1s
