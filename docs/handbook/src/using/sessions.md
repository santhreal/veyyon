# Sessions

A Veyyon session is the unit of interactive work. Start one in the repository you want to modify:

```shell
veyyon
```

The session records turns, tool activity, approvals, edits, and verification output. Long-running work
continues under context pressure through explicit goal state, compacted history, working-set facts, and
resume metadata, not through the raw transcript text alone.

## Common session actions

- Start fresh with `veyyon`.
- Continue saved work from the session picker on launch, or `/resume` inside the TUI.
- Branch a previous conversation with `/branch` (from a chosen user message) or duplicate the whole
  session with `/fork`.
- Manage saved sessions with `/session`; garbage-collect old artifacts with `veyyon gc`.
- Run a bounded non-interactive task by passing a prompt: `veyyon "…"`.

## Resuming and forking by id

On exit Veyyon prints `veyyon --resume <id>`. The id, a prefix of it, or a transcript path resumes
that session from any directory and any profile. The id of a spawned agent's transcript resumes that
transcript the same way.

- The launch runs under the profile that wrote the session, whichever profile it starts in.
- `--profile <name>` naming another profile forks the session into `<name>`: a new session in that
  profile, at the source's recorded working directory, with the source's history and the source
  as its parent. The source stays unchanged in its own profile. The launch prints the new id.
- `/resume <id>` inside a session relaunches Veyyon in the profile that wrote the session, as
  `/profile` does, when that is not the running profile.
- `--continue` and the session picker list the running profile's sessions only, and never list a
  spawned agent's transcript. Switching a running session to another profile's transcript, from an
  extension or RPC `switch_session`, fails and states the owning profile.
- The session reopens in place, in its recorded working directory, and the launch moves there. It is
  not copied into the directory you launched from. `--cwd <dir>` overrides it: the session's working
  directory moves to `<dir>` and the session records the change.
- When the recorded directory no longer exists, Veyyon prompts to move the session into the current
  directory. Without a terminal to prompt on, the launch fails and states the missing directory.

`veyyon --resume` with no id opens the session picker, and a picked session reopens in its recorded
working directory the same way.

`veyyon --fork <id>` copies the session into a new session in the current directory and leaves the
source unchanged. The launch runs under the profile that wrote the source, so the copy is written in
that profile. With `--profile <name>`, the copy is written in `<name>` instead.

## Long work

For large tasks, make the desired outcome explicit. Compaction summarizes older turns into goal,
constraints, progress, decisions, next steps and critical context, keeps the most recent turns
verbatim, and appends the list of files read and modified. See
[Compaction](../architecture/compaction.md).

## Session files are trees

A session file (`~/.veyyon/profiles/default/agent/sessions/**/<timestamp>_<id>.jsonl`, or `$XDG_DATA_HOME/veyyon/sessions/**` after `veyyon config init-xdg`) is an append-oriented log whose entries form a tree. Recorded session entries have an `id` and a `parentId`. Branching appends a new entry whose `parentId` states an earlier entry, so it starts a sibling branch from that point.

The *active leaf* advances to each appended entry. On load it falls back to the last entry in the file. Not every line has `parentId`: the first-line session header does not, and in-place refresh records are full replacements of the original logical record rather than tree entries. Storage maintenance may atomically rewrite the file to update the header or representation, but it preserves the history entries. Branches you navigate away from remain addressable.

Four properties are guaranteed by the storage layer:

- **No history deletion during navigation.** Branching appends new entries; abandoned entries remain addressable.
- **A corrupt header never initializes over existing bytes.** A non-empty file without a valid first session record is rejected. Veyyon leaves it byte-for-byte unchanged so you can inspect or repair it.
- **Recoverable record loss is operator-visible.** A malformed later record is skipped so one damaged line does not make the entire session unopenable. The session shows one bounded warning with the file, one-based line and byte offset, and shape problem. It never quotes the dropped record's content. Duplicate ids are last-write-win, and broken parent chains appear as extra roots.
- **Moves are transactional.** Moving a session changes the transcript, its artifacts, and its recorded working directory as one operation through the active storage backend. If relocation or the final header write fails, Veyyon restores the old paths and in-memory working directory.

Session files written by older Veyyon versions have no linkage fields; they load as a linear chain,
which is the exact shape they recorded.

### Navigating the tree

Run `/tree` in the TUI to browse every entry of the session, including branches you previously
abandoned. Picking an entry opens a small action menu:

- **Jump here** continues from that point. For a **user message** the jump lands immediately before it and
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
and the run reports it.

## Typing while the agent works

Input entered during a running turn goes to one of two places, and the bottom pane always shows
which:

- **Steer (`Enter`).** The message is injected into the *current* turn: the model sees it at the
  next tool boundary and adjusts course without abandoning its work.
- **Queue a follow-up (`Ctrl+Q`, or `Ctrl+Enter` where the terminal delivers it).** The message is queued in the running process and starts a
  **new turn** once the current one finishes. The queue is stored in memory for the lifetime of the
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

## Composer predictions

With composer predictions on, after each finished turn a prediction of the message you are likely
to send next is shown as dim text in the empty composer. `Tab` inserts it for editing; `Enter` then
sends it. Typing dismisses it, and a new turn, a session switch or compaction clears it. No
prediction is requested after an aborted or failed turn, or while the composer holds text. A
prediction reads the conversation and writes nothing to the session.

`composer.predictions.mode` selects which model writes the prediction. The default is `off`, so no
prediction request is sent until you choose another mode.

- `off` (default) requests no predictions. A stored `off` is never changed by connecting an
  account; the mode stays off until you choose another one.
- `chatgpt-pro` uses the ChatGPT Codex prediction service, and only with a ChatGPT Pro
  plan OpenAI Codex login, read from the login's access token. Any stored Codex account on the Pro
  plan qualifies, the one the session is routed to first, then `OPENAI_CODEX_OAUTH_TOKEN`. The
  request is sent with that login's own token, never with an account the session's routing would
  move to. The service supplies the prompt and reasoning effort and lists the models it serves no
  predictions for. The request goes to GPT-6 Astra or GPT-6.1 Sol, the models OpenAI supports for
  predictions, preferring the session's model when it is one of them, and is sent as an ephemeral
  fork of the session's thread. During the beta, OpenAI counts these predictions against no Codex
  usage limits or credits. Without a Pro-plan Codex login, or when `--api-key` or a `models.yml`
  `apiKey` replaces the Codex logins, no request is sent and no warning is shown. In `/settings` the
  row then reads `Off (no ChatGPT Pro account)`, and the option is greyed out and cannot be chosen
  until a ChatGPT Pro account is connected.
- `custom` sends a built-in prompt to the models in `composer.predictions.model`, chosen from every
  provider in the settings model picker. The first one with credentials writes the prediction; a
  `:level` suffix sets its thinking level. Unset, the session's model writes it. When no listed
  model is usable, the reason is shown once as a warning.

```yaml
composer:
  predictions:
    mode: custom
    model: [anthropic/claude-sonnet-4-5, openai/gpt-5.5:low]
```

## Next

Read [Examples](./examples.md) for concrete prompts and workflows.
