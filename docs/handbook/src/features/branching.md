# Session branching

Veyyon sessions are **trees**, not linear chat logs. Each entry has `id` and `parentId`; the active position is the current **leaf**. Branching appends from the chosen parent without deleting sibling branches.

Engine reference: `docs/tree.md`, `docs/internal/session-tree-plan.md`.

## Navigate in place: `/tree`

`/tree` opens the session tree selector (`TreeSelectorComponent`). It moves the leaf **within the same session file**, no new session id.

Also opens via:

- Keybinding `app.session.tree`
- Double-Escape when `doubleEscapeAction = "tree"` (default)
- `/branch` when `doubleEscapeAction = "tree"` (routes to tree instead of user-message branch picker)

### Filters

`treeFilterMode` setting (cycle with `Ctrl+O` / `Shift+Ctrl+O`, or `Alt+D/T/U/L/A` shortcuts):

| Mode | Shows |
| --- | --- |
| `default` | Conversation nodes; hides label/custom/model_change/thinking bookkeeping |
| `no-tools` | `default` plus hides tool-result-only assistant messages |
| `user-only` | User messages only |
| `labeled-only` | Entries with labels |
| `all` | Every entry type |

Search is fuzzy, case-insensitive, AND across tokens.

### Selection behavior

- **User / custom_message:** leaf moves to parent; message text prefills composer for edit/resubmit.
- **Other entry types:** leaf becomes selected node; empty composer.
- **Current leaf:** no-op.

Labels: `Shift+L` set/clear; stored as append-only `label` entries.

Optional **branch summary** when `branchSummary.enabled` is true: after picking a node, choose summarize abandoned path before continuing.

## New session file: `/branch` and `/fork`

| Command | Behavior |
| --- | --- |
| `/branch` | Pick a **user message**; copy history up to that boundary into a **new session file** (or reset root); prefills composer. When `doubleEscapeAction = "tree"`, opens `/tree` instead. |
| `/fork` | Duplicate the **entire** current session (every entry, including sibling branches) into a new persisted file (`handleForkCommand`). No entry picker; for a slice from a chosen point, use `/branch`. |
| CLI | `veyyon --fork <session-id>` at startup |

`/fork` and `/branch` change session **files**. `/tree` does not.

There is no `/clone` slash command in the shipped registry.

## Ephemeral side questions: `/btw`

`/btw <question>` (not `/side`) runs an ephemeral side thread with inherited context, then returns. See implementation `handleBtwCommand` in `interactive-mode.ts`.

`/tan` runs tangential background agent work, separate from `/btw`.

## Configuration

```yaml
doubleEscapeAction: tree   # tree | branch | none
treeFilterMode: default    # default | no-tools | user-only | labeled-only | all
branchSummary:
  enabled: false
  reserveTokens: 16384
```

## Command availability

Branching commands require a started session (at least one turn). Some commands are disabled while tasks run; `/btw` may remain available for steering, see TUI status when blocked.

## See also

- [Sessions](../using/sessions.md)
- [Session operations](https://github.com/santhreal/veyyon/blob/main/docs/internal/session-operations-export-share-fork-resume.md)
