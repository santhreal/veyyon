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
a tree. Recorded session entries carry an `id` and a `parentId`, and branching works by appending a
new entry whose `parentId` names an earlier entry, so it starts a sibling branch from that point.
The *active leaf* is implicit: it advances to each appended entry, and on load it falls back to the
last entry in the file. Not every line carries `parentId`: the first-line session header does not,
and in-place refresh records (a replaced session header, a rewritten custom message) are full
replaces of the original record, not entries on the tree. Nothing is ever rewritten: branches you
navigate away from stay in the file, and resuming
a session materializes only the entries along the active path (for a session with no branches, that
is the entire file, exactly as before).

Two properties are guaranteed by the storage layer:

- **No history rewriting.** Branching appends new entries; abandoned entries remain addressable.
- **Loud, fail-open on corruption.** A malformed record is skipped so one corrupt line cannot make
  a whole session unopenable, but the skip is never silent: each dropped record is logged with its
  offset. Duplicate ids are last-write-win, and entries with a broken parent chain surface as extra
  roots rather than blocking the load.

Session files written by older Veyyon versions have no linkage fields; they load as a linear chain,
which is the exact shape they recorded.

### Navigating the tree

Run `/tree` in the TUI to browse every entry of the session, including branches you previously
abandoned. Picking an entry opens a small action menu:

- **Jump here** continues from that point. For a **user message** the jump lands just before it and
  places the full message text in the composer, ready to edit and resubmit. The **start of
  conversation** recalls the original prompt into the composer so you can edit and resubmit it.
  Anything else (an agent reply, a compaction) branches from that entry with an empty composer.
- **Label…** attaches a short free-text label to the entry so you can find it again later. Labels
  render as `[label]` tags in the tree. Submitting empty text, or picking
  **Clear label**, removes it.

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
  `/branch`. `veyyon --fork <session-id>` does the same at startup. The launch session picker
  instead copies only the picked session's ancestor path (the active lineage) into the new file.
- **`/branch`** picks an earlier **user message** and copies the history up to that point (or resets
  to a fresh root if the picked message is the first one) into a new session file, then recalls the
  message text into the composer for edit-and-resubmit.

There is no `/clone` slash command in the shipped registry.

Labels are stored in the session file itself as append-only bookkeeping lines (last write wins), so
they survive resume and never rewrite history.

### Exporting a session

`/export` renders the current session as a self-contained HTML file you keep, for backup,
inspection, or sharing.

- `/export`: write to the session's working directory under a generated file name.
- `/export <path>`: write to `<path>`.

The command prints the destination and opens the result in your browser. It never modifies the live
session.

Programmatic access uses the Agent Client Protocol (`veyyon acp`) or SDK embedding; no separate daemon
is required. Session tree operations in the TUI use `/tree`, `/branch`, and `/fork`.

## Cleaning up old sessions

`veyyon gc` reclaims disk: it sweeps blobs no session references any more, archives cold sessions, and
checkpoints the database write-ahead logs. It is a dry run unless you pass `--apply`, and it prints what
it would do either way.

GC never touches a file that was written recently, because a running veyyon may still be appending to it.
That window is five minutes by default, and you can change it:

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
gc:
   writeGraceMinutes: 15
```

Pass `--write-grace-minutes` to override it for one run. The minimum is one minute: a shorter window
would let GC delete a blob a live session wrote a moment ago, so a smaller value is raised to the minimum
and the run says so.

## Typing while the agent works

Input entered during a running turn goes to one of two places, and the bottom pane always shows
which:

- **Steer (`Enter`).** The message is injected into the *current* turn: the model sees it at the
  next tool boundary and adjusts course without abandoning its work.
- **Queue a follow-up (`Ctrl+Q`, or `Ctrl+Enter` where the terminal delivers it).** The message is queued in the running process and starts a
  **new turn** once the current one finishes. The queue lives in memory for the lifetime of the
  process; it is not written to the session file, so it does not survive a restart. Slash commands and `!` shell escapes
  queue client-side instead; they are local actions, not model input.

Queued messages render under the composer grouped as `Steering·N` and `After yield·N`, with the
dequeue key shown as a hint. They are never delivered after an interrupt: pressing `Esc` aborts the
turn and pulls every queued follow-up back into the composer so nothing you typed is lost. To edit
a queued follow-up without interrupting, press the dequeue chord (`Alt+Up` by default, remappable):
the most recent follow-up returns to the composer and older ones stay queued.

Delivery is governed by `steeringMode` and `followUpMode` (both `one-at-a-time` by default; set to
`all` to deliver every queued message at the next boundary):

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
steeringMode: all
followUpMode: all
```

Programmatic clients use the `follow_up` RPC command to queue a follow-up on an active session.
Recalling a queued follow-up is a TUI-local action (`Esc` or the dequeue chord); the
RPC protocol has no recall command. An empty follow-up is a no-op in the TUI, and `/queue` with no
text shows a usage warning.

## Next

Read [Examples](./examples.md) for concrete prompts and workflows.
