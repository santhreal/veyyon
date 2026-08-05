# Veyyon secret manager demo: everything you do to a credential after storing it.
#
# The card is the whole management surface in a terminal, because `/secret` now reads its
# argument line as the credential itself and the old verbs only exist for clients with no
# terminal. So this tape walks the surfaces that replaced them: the roster, the detail pane,
# a search, a sort, the expansion log, and tracing one credential to the uses it paid for.
#
# No secret VALUE appears at any point. That is the claim the recording exists to support.
#
# Regenerate: `bash scripts/demos/record-secret-manager.sh`.
# Do not run this tape directly. The driver owns the throwaway project and the seeded vault.

Output assets/demo-secret-manager.gif

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
Type "bash scripts/demos/launch.sh" Enter
Sleep 4s
Show

# The roster. Four credentials across all three scopes, with three different answers in the
# EXPIRES column, including one that never expires.
Type "/secret manager"
Sleep 700ms
Escape
Enter
Sleep 3s

# Walk the list, then open the detail pane on a credential that has actually been spent.
Down
Sleep 700ms
Down
Sleep 700ms
Type "i"
Sleep 3s
Type "i"
Sleep 700ms

# Search. The roster narrows as the query lands, and the match is highlighted in the row.
Type "/"
Sleep 700ms
Type "token"
Sleep 1s
Enter
Sleep 2500ms
Escape
Sleep 1500ms

# Sort by another column.
Type "s"
Sleep 2s
Type "s"
Sleep 2s

# The question worth asking before a revoke: what stops working. `u` opens the log showing
# only the uses that spent the selected credential.
Type "u"
Sleep 3500ms

# Search within those uses. The notice above the table keeps saying what is hidden.
Type "/"
Sleep 700ms
Type "release"
Sleep 1s
Enter
Sleep 3s
Escape
Sleep 1500ms

# Widen back to every recorded use, then read the whole log.
Escape
Sleep 2500ms
Down
Sleep 800ms
Down
Sleep 2s

# The full key map.
Type "?"
Sleep 4s
Escape
Sleep 1s

Escape
Sleep 2s
