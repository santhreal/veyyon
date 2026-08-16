# The session tree card. One real turn first, so the tree has entries.
Output "/out/tree.gif"
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
Type "reply with one short sentence about parsers"
Sleep 400ms
Enter
Sleep 95s
Type "/tree"
Sleep 800ms
Enter
Sleep 4s
Screenshot "/out/overlay-tree.png"
Sleep 1s
