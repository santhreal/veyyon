# Veyyon account manager: what `/providers` shows once a provider holds more than one account.
#
# The old screen was one row per provider carrying a bare `logged in` tag, which could not answer
# any of the questions being asked of it. This tape walks the card that replaced it: three Anthropic
# accounts with their own identities, plans and health, the pane split, the inline rename, the
# armed logout, and the load-balancing gate whose default is off on purpose.
#
# Every account in the recording is fabricated and authenticates to nothing.
#
# Regenerate: `bash scripts/demos/record-account-manager.sh`.
# Do not run this tape directly. The driver owns the throwaway HOME and the seeded credentials.

Output assets/demo-account-manager.gif

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
Type "bash scripts/demos/launch-accounts.sh" Enter
Sleep 6s
Show

# The card. Anthropic is selected in the sidebar and holds three accounts, one of them expired.
Type "/providers"
Sleep 700ms
Enter
Sleep 3s
Screenshot assets/account-manager-card.png

# Walk the accounts. The pin, the plan and the health line change per row.
Down
Sleep 1200ms
Screenshot assets/account-manager-second-account.png
Down
Sleep 1500ms
Screenshot assets/account-manager-expired-account.png

# The sidebar, so the two panes' cursors read as different things.
Left
Sleep 1200ms
Screenshot assets/account-manager-sidebar.png
Down
Sleep 1200ms
Screenshot assets/account-manager-codex.png
Right
Sleep 1000ms

# The only editable field on the card.
Type "n"
Sleep 1200ms
Screenshot assets/account-manager-rename.png
Escape
Sleep 800ms

# `x` arms rather than acts, so the confirmation has to be impossible to miss.
Type "x"
Sleep 1500ms
Screenshot assets/account-manager-logout-armed.png
Escape
Sleep 800ms

# The gate. Off by default: spending a second subscription is the operator's decision.
Type "b"
Sleep 1500ms
Screenshot assets/account-manager-balancing-on.png
Type "b"
Sleep 1200ms

Escape
Sleep 1500ms
