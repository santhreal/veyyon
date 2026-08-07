# Keybindings reference

Quick lookup for the default Veyyon TUI shortcuts. Every row below is taken from the default
binding tables in code (`KEYBINDINGS` in `config/keybindings.ts` and `TUI_KEYBINDINGS` in
`@veyyon/tui`), so it matches what a fresh profile does. Run **`/hotkeys`** in a session for the
live list after your remaps. For the full guide on customizing, see
[Keybindings and Vim mode](../features/keybindings.md).

## App

| Binding | Action |
| --- | --- |
| `esc` | Interrupt the current operation (`app.interrupt`) |
| `ctrl+c` | Clear screen or cancel (`app.clear`) |
| `ctrl+d` | Exit the application (`app.exit`) |
| `ctrl+z` | Suspend the application (`app.suspend`) |
| `ctrl+b` | Move the running foreground command to a background job (`app.bash.background`); active only while a foreground `bash` call is waiting, otherwise it keeps its editor meaning (cursor left) |
| `ctrl+l` | Reset the terminal display (`app.display.reset`) |
| `shift+tab` | Cycle thinking level (`app.thinking.cycle`) |
| `ctrl+t` | Toggle thinking mode (`app.thinking.toggle`) |
| `ctrl+p` / `shift+ctrl+p` | Cycle model forward / backward (`app.model.cycleForward` / `app.model.cycleBackward`) |
| `alt+m` | Select model (`app.model.select`) |
| `alt+p` | Select a temporary model for the current session (`app.model.selectTemporary`) |
| `ctrl+o` | Expand tool output (`app.tools.expand`) |
| `ctrl+g` | Open the draft in an external editor (`app.editor.external`) |
| `ctrl+q` or `ctrl+enter` | Send a follow-up message (`app.message.followUp`) |
| `alt+r` | Retry the last failed assistant turn (`app.retry`) |
| `alt+up` | Dequeue a queued message back into the editor (`app.message.dequeue`) |
| `alt+shift+p` | Toggle plan mode (`app.plan.toggle`) |
| `alt+a` | Open the Agent Control Center (`app.agents.hub`) |
| `ctrl+r` | Search prompt history (`app.history.search`) |
| `alt+shift+l` | Copy the current line (`app.clipboard.copyLine`) |
| `alt+shift+c` | Copy the whole prompt (`app.clipboard.copyPrompt`) |
| `ctrl+v` (`alt+v` fallback on Windows, `super+v` on macOS) | Paste from the clipboard, image preferred (`app.clipboard.pasteImage`) |
| `ctrl+shift+v` or `alt+shift+v` | Paste clipboard text raw, no collapse (`app.clipboard.pasteTextRaw`) |

You can also set the effort by name with the `/effort` command (its alias is `/thinking`). With no
argument it opens a picker; `/effort high` sets the level directly. The choice lasts for this session; the saved default
lives under Settings → Model → Default Effort.

Unbound by default, remappable: `app.session.new`, `app.session.tree`, `app.session.fork`,
`app.session.resume`, and `app.stt.toggle` (speech-to-text; hold `Space` to record by default).

## Composer

| Binding | Action |
| --- | --- |
| `enter` | Submit the current message (`tui.input.submit`) |
| `shift+enter` or `ctrl+j` | Insert a new line (`tui.input.newLine`) |
| `tab` | Autocomplete (`tui.input.tab`) |

The composer does not copy. Use `alt+shift+l` to copy the current line and
`alt+shift+c` to copy the whole prompt, both listed under Clipboard above.
`ctrl+c` interrupts the running turn.

## Editor

| Binding | Action |
| --- | --- |
| `up` / `down` | Move cursor up / down |
| `left` or `ctrl+b` | Move cursor left |
| `right` or `ctrl+f` | Move cursor right |
| `alt+left`, `ctrl+left`, or `alt+b` | Move cursor left by one word |
| `alt+right`, `ctrl+right`, or `alt+f` | Move cursor right by one word |
| `home` or `ctrl+a` | Move cursor to the start of the line |
| `end` or `ctrl+e` | Move cursor to the end of the line |
| `ctrl+]` / `ctrl+alt+]` | Jump forward / backward to a character |
| `page-up` / `page-down` | Page up / down |
| `backspace` | Delete the character to the left |
| `delete` or `ctrl+d` | Delete the character to the right |
| `ctrl+w`, `alt+backspace`, `ctrl+backspace`, or `super+alt+backspace` | Delete the word to the left |
| `alt+delete`, `alt+d`, `super+alt+delete`, or `super+alt+d` | Delete the word to the right |
| `ctrl+u` | Delete from the cursor to the start of the line |
| `ctrl+k` | Delete from the cursor to the end of the line |
| `ctrl+y` / `alt+y` | Yank / yank-pop the kill buffer |
| `ctrl+-` or `ctrl+_` | Undo |

## Lists and selectors

| Binding | Action |
| --- | --- |
| `up` / `down` | Move the selection up / down |
| `page-up` / `page-down` | Move the selection by one page |
| `enter` | Confirm the selection |
| `esc` or `ctrl+c` | Cancel and close |

## Vim mode

Modal (vim-style) composer editing does not exist. There is no `/vim` command or
`toggle_vim_mode` action; the composer uses the bindings above.

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

Action IDs are namespaced (`app.model.cycleForward`, `app.plan.toggle`, `tui.select.pageUp`, …). Older
flat legacy names and `keybindings.json` files migrate automatically to the namespaced `.yml` form on
load. Run **`/hotkeys`** in a session to see active chords.

Full action-ID list and status-line gestures: [Keybindings and Vim mode](../features/keybindings.md)
and repository [`docs/keybindings.md`](../../../keybindings.md).
