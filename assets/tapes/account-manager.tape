# Veyyon accounts, end to end: the `/providers` card and the `/login` command that feeds it.
#
# The old screen was one row per provider carrying a bare `logged in` tag, which could not answer
# any of the questions being asked of it. This tape walks what replaced it, in the order an operator
# meets it: the card with three Anthropic accounts and their identities, plans and health; every key
# it offers (switch, rename, re-probe, usage, add, logout, balancing); and then the command half,
# where `/login` has to answer the name that was typed rather than a sentence about OAuth callbacks.
#
# Every account in the recording is fabricated and authenticates to nothing, and every outbound
# request is pointed at a closed port, so the health probe fails on purpose: what the tape is about
# is what the card SAYS when it does.
#
# Regenerate: `bash scripts/demos/record-account-manager.sh`.
# Do not run this tape directly. The driver owns the throwaway HOME and the seeded credentials, and
# it fails the recording when a screenshot comes out byte-identical to the one before it.

Output assets/demo-account-manager.gif
Output assets/demo-account-manager.mp4

Set Shell "bash"
Set FontSize 22
Set Width 1400
Set Height 800
Set Padding 30
Set Margin 40
Set MarginFill "#000000"
Set BorderRadius 0
Set Framerate 24
Set TypingSpeed 45ms
Set CursorBlink false
Set Theme {"name":"veyyon","black":"#000000","background":"#000000","foreground":"#C6CBD4","cursor":"#F0862E"}

Hide
Type "clear" Enter
Sleep 300ms
Type "bash scripts/demos/launch-accounts.sh" Enter
Sleep 6s
Show

# ── The card ────────────────────────────────────────────────────────────────────────────────────
# Anthropic is selected in the sidebar and holds three accounts, one of them expired. `work` is the
# account this session routes to, which is what the pin on the first row reports.
Type "/providers"
Sleep 700ms
Enter
Sleep 3s
Screenshot assets/account-manager-01-card.png
Sleep 900ms

# Walk the accounts: the identity, the plan and the health line change per row.
Down
Sleep 1s
Screenshot assets/account-manager-02-second-account.png
Sleep 900ms

# `enter` switches THIS PROVIDER to the selected account. It is per provider on purpose: Codex and
# Gemini stay where they are, and the choice is durable rather than a session pin.
Enter
Sleep 1500ms
Screenshot assets/account-manager-03-switched.png
Sleep 900ms

Down
Sleep 1200ms
Screenshot assets/account-manager-04-expired-account.png
Sleep 900ms

# ── The two panes ───────────────────────────────────────────────────────────────────────────────
Left
Sleep 1s
Screenshot assets/account-manager-05-sidebar.png
Sleep 900ms
Down
Sleep 1200ms
Screenshot assets/account-manager-06-codex.png
Sleep 900ms
Up
Sleep 600ms
Right
Sleep 800ms

# ── Renaming an account ─────────────────────────────────────────────────────────────────────────
# The only editable field on the card. A name is how three logins to the same provider stop being
# three rows of the same email.
Type "n"
Sleep 1s
Screenshot assets/account-manager-07-rename-open.png
Sleep 900ms
# The field opens PRE-FILLED with the current name, so this is an edit rather than a fresh entry:
# clearing it first is what the operator does, and typing straight into it appends.
Backspace 4
Sleep 400ms
Type "billing"
Sleep 800ms
Enter
Sleep 1500ms
Screenshot assets/account-manager-08-renamed.png
Sleep 900ms

# ── Re-probing ──────────────────────────────────────────────────────────────────────────────────
# `r` re-checks every credential for the selected provider. The tokens here are fabricated and the
# network is a closed port, so this is the failure path: what matters is that the card reports the
# upstream reason verbatim instead of a generic badge.
Type "r"
Sleep 4500ms
Screenshot assets/account-manager-09-reprobed.png
Sleep 900ms

# ── The add row, and the footer that follows the selection ──────────────────────────────────────
# `+ add another …` is a list position, not a caption. `n`, `u` and `x` all read the selected
# ACCOUNT, so on this row the footer drops them rather than advertising keys it will not answer.
Down
Down
Down
Sleep 1200ms
Screenshot assets/account-manager-10-add-row.png
Sleep 900ms
Up
Sleep 1200ms
Screenshot assets/account-manager-11-account-row.png
Sleep 900ms

# ── The logout confirm ──────────────────────────────────────────────────────────────────────────
# `x` arms and says which credential is about to go. A second `x` removes it; anything else at all
# takes the arm away, so the two halves of the confirmation stay adjacent.
Type "x"
Sleep 1500ms
Screenshot assets/account-manager-12-logout-armed.png
Sleep 900ms
Down
Sleep 1200ms
Screenshot assets/account-manager-13-logout-disarmed.png
Sleep 900ms

# ── The load-balancing gate ─────────────────────────────────────────────────────────────────────
# Off by default: every account here belongs to a real subscription with a real bill, so spreading
# one session across them is the operator's decision. The chip and the scope line both move, and the
# press states what the new state does and that it was saved.
Type "b"
Sleep 1500ms
Screenshot assets/account-manager-14-balancing-on.png
Sleep 900ms
Type "b"
Sleep 1500ms
Screenshot assets/account-manager-15-balancing-off.png
Sleep 900ms

Escape
Sleep 2s
Screenshot assets/account-manager-16-after-close.png
Sleep 900ms

# ── `/login`: the command answers the name you typed ────────────────────────────────────────────
# A name that is not a provider gets the name it nearly was and a pointer to the picker, bounded to
# what a reader can take in, rather than every signable provider or a sentence about a manual OAuth
# callback nobody mentioned.
Type "/login gpt-9-turbo-max"
Sleep 700ms
Enter
Sleep 2s
Screenshot assets/account-manager-17-login-unknown.png
Sleep 900ms

# A provider that exists and signs in with an API key is named, with the environment variable it
# actually reads. There is no browser login to start, and the refusal says so instead of talking
# about an OAuth callback nobody mentioned.
Type "/login groq"
Sleep 700ms
Enter
Sleep 2s
Screenshot assets/account-manager-18-login-api-key.png
Sleep 900ms

# The DISPLAY NAME works, because it is the spelling the card, the model hub and the picker print.
# The frame is taken while the login is in flight: the network here is a closed port, so the dialog
# collapses on its own a moment later.
Type "/login Anthropic"
Sleep 700ms
Enter
Sleep 1200ms
Screenshot assets/account-manager-19-login-dialog.png
Sleep 2s
Escape
Sleep 1500ms

# With no argument it asks which provider, so `/login` never has to be guessed at.
Type "/login"
Sleep 900ms
Enter
Sleep 2500ms
Screenshot assets/account-manager-20-login-picker.png
Sleep 900ms
Escape
Sleep 1500ms

# `/logout` resolves its argument against what is STORED, not only against providers with a browser
# login: groq authenticates with an API key, the card lists that key as a row, and the selector the
# command opens is the same one that removes it. A command refusing what the card two keystrokes
# away deletes is the two surfaces disagreeing about whether a credential exists.
Type "/logout groq"
Sleep 700ms
Enter
Sleep 2500ms
Screenshot assets/account-manager-21-logout-stored-key.png
Sleep 1500ms
