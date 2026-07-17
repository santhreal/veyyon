# Keybindings and Vim mode

Remap TUI shortcuts from **`~/.veyyon/agent/keybindings.yml`** (YAML map of action ID → chord or chord
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

> **Spec — not shipped:** a `/keymap` interactive remapper and nested `[tui.keymap.*]` tables. Veyyon
> uses `keybindings.yml` + `/hotkeys` instead.

## Vim mode

Modal (vim-style) composer editing does not exist. The composer ships with the
standard binding set in [Keybindings reference](../reference/keybindings-ref.md) only.
