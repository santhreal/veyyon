# The setup wizard, which a first run opens on its own. Recorded with the
# machine-wide config REMOVED, so this is the real first-run path and not a
# simulation of it. The footer is the subject: its keys are chips now.
Output "/out/wizard.gif"
Set Shell "bash"
Set FontFamily "JetBrains Mono"
Set FontSize 15
Set Width 1500
Set Height 900
Set Padding 14
Set Framerate 24
Set Theme { "background": "#1e2127", "foreground": "#d7dae0" }

Hide
Type "cd /sandbox/home/demo && export LOCAL_LLM_KEY=none && rm -f /sandbox/home/.veyyon/config.yml"
Enter
Type "bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b"
Enter
Sleep 20s
Show
Sleep 2s
Screenshot "/out/wizard-providers.png"
Right
Sleep 2s
Screenshot "/out/wizard-approvals.png"
Right
Sleep 2s
Screenshot "/out/wizard-subagents.png"
Sleep 1s
