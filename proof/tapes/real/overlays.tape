# Three converted overlays in one run: the session tree, the MCP add wizard and
# the pause screen. Real binary, real terminal, no model turn needed — these are
# chrome, and chrome is what the branch changed.
Output "/out/overlays.gif"
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
Show
Sleep 1s

Type "/mcp add"
Sleep 500ms
Enter
Sleep 3s
Screenshot "/out/overlay-mcp.png"
Escape
Sleep 2s

Type "/tree"
Sleep 500ms
Enter
Sleep 3s
Screenshot "/out/overlay-tree.png"
Escape
Sleep 2s

Type "/pause"
Sleep 500ms
Enter
Sleep 3s
Screenshot "/out/overlay-pause.png"
Sleep 2s
