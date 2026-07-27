# Keybindings

Remap TUI shortcuts from **`~/.veyyon/profiles/default/agent/keybindings.yml`** (YAML map of action ID → chord or chord
list). Run **`/hotkeys`** in a session to see active bindings.

## Customize keybindings

```yaml
app.model.cycleForward: Ctrl+P
app.model.selectTemporary: Alt+P
app.plan.toggle: Alt+Shift+P
app.history.search: []   # disable
```

Chord names match the UI (`Ctrl+P`, `Alt+Shift+P`, `Shift+Enter`). Older `keybindings.json` files migrate
to `.yml` on load.

Action IDs from older releases (`interrupt`, `fork`, `cursorUp`) are renamed to their current IDs
(`app.interrupt`, `app.session.fork`, `tui.editor.cursorUp`) the first time veyyon loads the file, and
the file is written back. The rename happens where the binding already sits, so your comments, blank
lines, and key order come back unchanged:

```yaml
# hold this one, muscle memory
interrupt: ctrl+x
```

becomes

```yaml
# hold this one, muscle memory
app.interrupt: ctrl+x
```

Common action IDs include `app.model.cycleForward`, `app.model.select`, `app.plan.toggle`,
`app.history.search`, `app.tools.expand`, `app.thinking.toggle`, `app.thinking.cycle` (`Shift+Tab`),
`app.editor.external` (`Ctrl+G`), `app.message.followUp`, `app.retry`, `app.display.reset`, and
`app.clipboard.pasteImage`.

Engineering detail: [`docs/keybindings.md`](../../../keybindings.md).

## Slash commands

| Command | Action |
| --- | --- |
| `/hotkeys` | Show active chords |
| `/settings` | Settings UI (includes keymap-related options) |

Remap keys by editing `keybindings.yml`; `/hotkeys` shows the current bindings.

There is no Vim or modal editing mode; the composer uses the bindings above.
