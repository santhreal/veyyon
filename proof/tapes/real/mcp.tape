# The MCP add-server wizard, a ModalShell card in the real binary.
Output "/out/mcp.gif"
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
Type "/mcp add"
Sleep 800ms
Enter
Sleep 4s
Screenshot "/out/overlay-mcp.png"
Sleep 1s
