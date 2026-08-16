# The settings Plugins tab, which now names its keys as chips and answers a click.
Output "/out/plugins.gif"
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
Type "/settings"
Sleep 1s
Enter
Sleep 3s
Show
# Left focuses the category sidebar; Plugins is the last category.
Left
Sleep 500ms
Down@220ms 15
Sleep 1s
Right
Sleep 2s
Screenshot "/out/settings-plugins.png"
Sleep 1s
