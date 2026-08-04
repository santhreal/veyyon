# The onboarding walkthrough: every step, its breadcrumb, and the way out.
#
# Regenerate with:
#   bash scripts/demos/record-onboarding.sh
#
# Each frame is the REAL SetupWizardComponent rendered against a throwaway
# profile by render-setup-wizard.ts, walked to the step with the wizard's own
# forward key, so the breadcrumb position and the footer are the component's own
# bytes. No model request is made and nothing touches the machine's real config.
#
# What the recording is meant to show, in order: the breadcrumb naming all five
# steps before you have visited any of them, every list fitting on screen, and
# the footer naming the key that leaves setup rather than telling you to abort.

Output assets/setup-onboarding.gif

Set Shell "bash"
Set FontSize 22
Set Width 1600
Set Height 900
Set Padding 30
Set Margin 40
Set MarginFill "#000000"
Set BorderRadius 0
Set Framerate 30
Set TypingSpeed 45ms
Set CursorBlink false
Set Theme {"name":"veyyon","black":"#000000","background":"#000000","foreground":"#C6CBD4","cursor":"#F0862E"}

Hide
Type "clear && bun scripts/demos/render-setup-wizard.ts --width 96 --rows 30 --scene providers" Enter
Sleep 3s
Show
Screenshot assets/.setup-onboarding-providers.png
Sleep 1600ms

Hide
Type "clear && bun scripts/demos/render-setup-wizard.ts --width 96 --rows 30 --scene subagents" Enter
Sleep 3s
Show
Sleep 1600ms

Hide
Type "clear && bun scripts/demos/render-setup-wizard.ts --width 96 --rows 30 --scene glyphs" Enter
Sleep 3s
Show
Sleep 1600ms

Hide
Type "clear && bun scripts/demos/render-setup-wizard.ts --width 96 --rows 30 --scene theme" Enter
Sleep 3s
Show
Sleep 1600ms

Hide
Type "clear && bun scripts/demos/render-setup-wizard.ts --width 96 --rows 30 --scene import" Enter
Sleep 3s
Show
Screenshot assets/.setup-onboarding-import.png
Sleep 2s
