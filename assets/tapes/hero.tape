# Veyyon hero demo: the agent completes a real task end to end.
#
# This is the flagship demo, so it follows the one rule in the record-demo skill
# (.veyyon/skills/record-demo/SKILL.md): submit a prompt and show the OUTCOME,
# never stop at the typed prompt. Veyyon boots, takes a real request against the
# isolated fixture, reads rate-limiter.ts, applies an edit, runs its focused test,
# and ends on the verified result a reader came to see.
#
# Deterministic: scripts/demos/record.sh resets ~/orbit/src from a pristine copy
# before recording, and scripts/demos/launch.sh runs under the isolated demo
# profile with Gemini 3.6 Flash pinned high (wire: gemini-3.6-flash-high).
# Regenerate: `bash scripts/demos/record.sh hero`.
# The demo profile must be authenticated with Antigravity. A workflow demo makes
# a real model call, so a maintainer records this, not CI.
#
# Sleeps are sized for the demo model to finish reading and editing one file. If
# a run cuts off before the diff renders, raise the final Sleep, do not trim the
# task.

Output assets/demo-hero.gif

Set Shell "bash"
Set FontSize 22
Set Width 1400
Set Height 800
Set Padding 30
Set Margin 40
Set MarginFill "#000000"
Set BorderRadius 0
Set Framerate 30
Set TypingSpeed 55ms
Set CursorBlink false
Set Theme {"name":"veyyon","black":"#000000","background":"#000000","foreground":"#C6CBD4","cursor":"#F0862E"}

Hide
Type "clear" Enter
Sleep 300ms
Type "bash scripts/demos/launch.sh --auto-approve" Enter
Sleep 1500ms
Show

# The ember-sun splash and composer settle.
Sleep 3s

# A real request against the fixture. Submit it: this Enter is the line the old
# tape was missing.
Type "document the token-bucket algorithm in src/rate-limiter.ts with a doc comment, then run src/rate-limiter.test.ts and report the exact result"
Sleep 1500ms
Enter

# The agent reads the file, applies the edit, runs the focused suite, and
# reports. End on the verified outcome, not the spinner.
Sleep 120s
