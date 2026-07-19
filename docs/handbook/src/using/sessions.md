# Sessions

A Veyyon session is the unit of interactive work. Start one in the repository you want to modify:

```shell
veyyon
```

The session records turns, tool activity, approvals, edits, and verification output. Long-running work
should survive context pressure through explicit goal state, compacted history, working-set facts, and
resume metadata rather than relying on the model to remember everything from raw transcript text.

## Common session actions

- Start fresh with `veyyon`.
- Continue saved work from the session picker on launch, or `/resume` inside the TUI.
- Branch a previous conversation with `/branch` (from a chosen user message) or duplicate the whole
  session with `/fork`.
- Manage saved sessions with `/session`; garbage-collect old artifacts with `veyyon gc`.
- Run a bounded non-interactive task by passing a prompt: `veyyon "…"`.

Veyyon resumes from the launch picker or `/resume`, and branches with `/branch` / `/fork`.

## Long work

For large tasks, make the desired outcome explicit. The harness should preserve active instructions,
recent turns, working files, verification facts, and unresolved blockers through compaction. When a
session resumes, Veyyon should make the important state visible to the next model turn instead of
presenting a clean-looking summary that dropped the real constraint.

## Session files are trees

A session file (`~/.veyyon/profiles/default/agent/sessions/**/<timestamp>_<id>.jsonl`) is an append-only log, but its entries form
a tree. Every recorded line carries an `id` and a `parent_id`, and a `leaf_move` line moves the
session's *active leaf* to any earlier entry, so the next recorded entry starts a sibling branch from
that point. Nothing is ever rewritten: branches you navigate away from stay in the file, and resuming
a session materializes only the entries along the active path (for a session with no branches, that
is the entire file, exactly as before).

Two properties are guaranteed by the storage layer:

- **No history rewriting.** Branching appends a pointer move; abandoned entries remain addressable.
- **Fail closed on corruption.** A file whose linkage is broken (duplicate ids, unknown parents, a
  leaf move to a missing entry) refuses to load with an error naming the bad entry, rather than
  silently flattening or truncating the conversation.

Session files written by older Veyyon versions have no linkage fields; they load as a linear chain,
which is the exact shape they recorded.

### Navigating the tree

Run `/tree` in the TUI to browse every entry of the session, including branches you previously
abandoned. Picking an entry opens a small action menu:

- **Jump here** continues from that point. For a **user message** the jump lands just before it and
  places the full message text in the composer, ready to edit and resubmit; the **start of
  conversation** resets to an empty conversation with the original prompt recalled; anything else
  (an agent reply, a compaction) branches from that entry with an empty composer.
- **Label…** attaches a short free-text label to the entry so you can find it again later. Labels
  render as `[label]` tags in the tree; the corresponding `tui` option in `config.yml` also shows when
  each label was set. Submitting empty text, or picking **Clear label**, removes it.

The tree view filter modes (`treeFilterMode` in `config.yml`, also toggled in the `/tree` UI) are:

| Mode | What it shows |
| --- | --- |
| `default` | Conversation entries (hides low-signal noise) |
| `no-tools` | `default` plus hides tool-result-only assistant messages |
| `user-only` | User messages only |
| `labeled-only` | Entries with labels |
| `all` | Every raw entry |

Typing filters rows by preview and label text. There is no separate Conversation/User/Labeled/All tab chrome beyond these filter modes, see [Branching](../features/branching.md).

### Forking and branching to a new file

`/fork` and `/branch` both create a new session file and never modify the original; `/tree`
navigation above stays inside the current file.

- **`/fork`** duplicates the **entire** current session (every entry, including sibling branches)
  into a new persisted file. There is no entry picker; for a slice from a chosen point, use
  `/branch`. `veyyon --fork <session-id>` does the same at startup, and the launch session picker
  forks a recorded session the same way.
- **`/branch`** picks an earlier **user message** and copies the history up to that point (or resets
  to a fresh root if the picked message is the first one) into a new session file, then recalls the
  message text into the composer for edit-and-resubmit.

There is no `/clone` slash command in the shipped registry.

Labels are stored in the session file itself as append-only bookkeeping lines (last write wins), so
they survive resume and never rewrite history.

### Exporting a session

`/export` writes a copy of the current session to a file you keep, for backup, inspection, or
moving a conversation between machines. The copy is the session's rollout file (append-only JSONL,
Veyyon's portable session format).

- `/export`: copy to the session's working directory under the rollout's own file name.
- `/export <path>`: copy to `<path>`. The path may be absolute, relative to the working directory,
  or `~`-prefixed; if it names an existing directory, the rollout's file name is used inside it.

The command reports the destination and the number of bytes written, and never modifies the live
session.

Programmatic access uses the Agent Client Protocol (`veyyon acp`) or SDK embedding; no separate daemon
is required. Session tree operations in the TUI use `/tree`, `/branch`, and `/fork`.

## Typing while the agent works

Input entered during a running turn goes to one of two places, and the bottom pane always shows
which:

- **Steer (`Enter`).** The message is injected into the *current* turn: the model sees it at the
  next tool boundary and adjusts course without abandoning its work.
- **Queue a follow-up (`Tab`, or `alt+enter`).** The message is queued on the *server* and starts a
  **new turn** once the current one finishes. Follow-ups survive TUI restarts and session resumes
  because the queue lives with the session, not the client. Slash commands and `!` shell escapes
  queue client-side instead; they are local actions, not model input.

Queued follow-ups render under the composer ("Follow-ups queued to run after this turn settles")
until they are delivered. They are never delivered after an interrupt: pressing `Esc` aborts the
turn and pulls every queued follow-up back into the composer so nothing you typed is lost. To edit
a queued follow-up without interrupting, press the edit-queued-message chord (`alt+up` by default,
also `shift+left`): the most recent follow-up returns to the composer and older ones stay queued.

Delivery is governed by `steeringMode` and `followUpMode` (both `one-at-a-time` by default; set to
`all` to deliver every queued message at the next boundary):

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
steeringMode: all
followUpMode: all
```

Programmatic clients use `turn/followUp` to queue a follow-up on an active thread and
`thread/followUps/recall` to take every queued follow-up back off the queue (the response returns
the recalled messages). Queueing an empty message is refused with an error.

## Next

Read [Examples](./examples.md) for concrete prompts and workflows.
