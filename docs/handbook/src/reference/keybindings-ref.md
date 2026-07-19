# Keybindings reference

Quick lookup for the default Veyyon TUI shortcuts. For the full guide on customizing, remapping, and Vim mode, see [Keybindings and Vim mode](../features/keybindings.md).

## Global

| Binding | Action |
| --- | --- |
| `ctrl-t` | Open transcript scrollback |
| `ctrl-g` | Open external editor for the current draft |
| `ctrl-o` | Copy the last agent response to the clipboard |
| `ctrl-l` | Clear TUI history |
| `alt-r` | Toggle raw scrollback mode |
| (unbound) | Toggle Vim mode |
| (unbound) | Toggle Fast mode |

## Chat

| Binding | Action |
| --- | --- |
| `esc` | Interrupt the running turn |
| `alt-,` or `shift-down` | Decrease reasoning effort |
| `alt-.` or `shift-up` | Increase reasoning effort |
| `alt-up` or `shift-left` | Edit the most recently queued message |

## Composer

| Binding | Action |
| --- | --- |
| `enter` | Submit the current message |
| `tab` | Queue the current message while a task is running |
| `alt-enter` | Queue the current message as a follow-up turn |
| `?` or `shift-?` | Toggle the composer shortcut helper |
| `ctrl-r` | Open reverse history search or move to the previous match |
| `ctrl-s` | Move to the next match in reverse history search |

## Editor

| Binding | Action |
| --- | --- |
| `ctrl-j`, `ctrl-m`, `enter`, `shift-enter`, `alt-enter` | Insert a new line |
| `left` or `ctrl-b` | Move cursor left |
| `right` or `ctrl-f` | Move cursor right |
| `up` or `ctrl-p` | Move cursor up |
| `down` or `ctrl-n` | Move cursor down |
| `alt-b`, `alt-left`, `ctrl-left` | Move cursor left by one word |
| `alt-f`, `alt-right`, `ctrl-right` | Move cursor right by one word |
| `home` or `ctrl-a` | Move cursor to the start of the line |
| `end` or `ctrl-e` | Move cursor to the end of the line |
| `backspace`, `shift-backspace`, `ctrl-h` | Delete the character to the left |
| `delete`, `shift-delete`, `ctrl-d` | Delete the character to the right |
| `alt-backspace`, `ctrl-backspace`, `ctrl-shift-backspace`, `ctrl-w`, `ctrl-alt-h` | Delete the word to the left |
| `alt-delete`, `ctrl-delete`, `ctrl-shift-delete`, `alt-d` | Delete the word to the right |
| `ctrl-u` | Delete from the cursor to the start of the line |
| `ctrl-k` | Delete from the cursor to the end of the line |
| `ctrl-y` | Paste the deleted text buffer |

## Pager

| Binding | Action |
| --- | --- |
| `up` or `k` | Scroll up one row |
| `down` or `j` | Scroll down one row |
| `page-up`, `shift-space`, or `ctrl-b` | Scroll up one page |
| `page-down`, `space`, or `ctrl-f` | Scroll down one page |
| `ctrl-u` | Scroll up half a page |
| `ctrl-d` | Scroll down half a page |
| `home` | Jump to the beginning |
| `end` | Jump to the end |
| `q` or `ctrl-c` | Close the pager |
| `ctrl-t` | Close the transcript view |

## List

| Binding | Action |
| --- | --- |
| `up`, `ctrl-p`, `ctrl-k`, `k` | Move selection up |
| `down`, `ctrl-n`, `ctrl-j`, `j` | Move selection down |
| `left` or `ctrl-h` | Move selection left |
| `right` or `ctrl-l` | Move selection right |
| `page-up` or `ctrl-b` | Move up one page |
| `page-down` or `ctrl-f` | Move down one page |
| `home` | Jump to the first item |
| `end` | Jump to the last item |
| `enter` | Accept the current selection |
| `esc` | Cancel and close the list |

## Approval

| Binding | Action |
| --- | --- |
| `ctrl-a` or `ctrl-shift-a` | Open the fullscreen approval view |
| `o` | Open the requesting thread |
| `y` | Approve the current request |
| `a` | Approve similar requests for the rest of the session |
| `p` | Approve similar requests matching the command prefix |
| `d` | Deny the request |
| `esc` or `n` | Decline the request and prompt for feedback |
| `c` | Cancel the elicitation prompt |

## Vim mode

Modal (vim-style) composer editing does not exist. There is no `/vim` command or
`toggle_vim_mode` action; the composer uses the standard bindings above.

## Customizing (real path: keybindings.yml)

Custom bindings are **shipped**, but the config surface is its own file, not a `tui.keymap` block in
`config.yml`. Set bindings by action ID in **`~/.veyyon/profiles/default/agent/keybindings.yml`** (YAML map of action ID
→ chord or chord list). A single string, a list of chords, or an empty list (disables the action) are
all valid values:

```yaml
app.model.cycleForward: Ctrl+P
app.history.search: []   # disables the action
app.clipboard.copyLine: [Ctrl+C, Alt+C]
```

Action IDs are namespaced (`app.model.cycleForward`, `app.plan.toggle`, `tui.select.pageUp`, …), not the
`global`/`clear_terminal`-style context keys shown in older drafts of this page. Older flat legacy names
and `keybindings.json` files migrate automatically to the namespaced `.yml` form on load. Run
**`/hotkeys`** in a session to see active chords.

Customize bindings in the flat `keybindings.yml` under the agent dir (see above). Full action-ID list and Vim mode: [Keybindings and Vim mode](../features/keybindings.md) and repository [`docs/keybindings.md`](../../../keybindings.md).
