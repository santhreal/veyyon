# The login card, reached with /login. No account is reachable from the container.
Output "/out/login.gif"
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
Type "/login"
Sleep 1s
Enter
Sleep 800ms
Enter
Sleep 5s
Screenshot "/out/overlay-login-list.png"
Sleep 1s
Down
Sleep 500ms
Screenshot "/out/overlay-login-hover.png"
Sleep 1s
