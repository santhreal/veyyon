# The Subagents settings tab, in a real terminal, in the real binary.
Output "/out/settings-subagents.gif"
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
Sleep 18s
Type "/settings"
Sleep 1s
Enter
Sleep 3s
Show
# Left focuses the category sidebar, then walk down to Subagents and enter the pane.
Left
Sleep 500ms
Down@220ms 11
Sleep 1s
Right
Sleep 2s
Screenshot "/out/settings-subagents.png"
Sleep 1s
