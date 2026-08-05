# Veyyon Model Goal Budgets setting in one deterministically seeded state.
#
# Do not run this tape directly. Regenerate the disabled-vs-enabled pair with:
#   bash scripts/demos/record-goal-budget-settings.sh
#
# The driver writes assets/goal-budget-settings-off.png and
# assets/goal-budget-settings-on.png, then restores the default-off setting.
# Settings navigation is offline and makes no model call.

Output assets/.goal-budget-settings-shot.gif

Set Shell bash
Set FontSize 22
Set Width 1400
Set Height 720
Set Padding 30
Set Margin 40
Set MarginFill "#000000"
Set BorderRadius 0
Set Framerate 30
Set TypingSpeed 55ms
Set CursorBlink false
Set Theme { "name": "veyyon", "black": "#000000", "background": "#000000", "foreground": "#C6CBD4", "cursor": "#F0862E" }

Env VEYYON_DEMO_CWD "/tmp/veyyon-goal-budget-demo"

Hide
Type "mkdir -p /tmp/veyyon-goal-budget-demo && clear" Enter
Sleep 300ms
Type "bash scripts/demos/launch.sh" Enter
Sleep 3s
Show

Type "/settings"
Sleep 700ms
Enter
Sleep 1200ms
Type "/"
Sleep 400ms
Type "model goal budgets"
Sleep 2000ms

Screenshot assets/.goal-budget-settings-shot.png
Sleep 600ms
