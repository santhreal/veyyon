# Multi-agent monitoring

The interactive TUI is the main surface for one session. Status line, session tree, background jobs, the Agent Control Center, and optional swarm orchestration cover multi-agent work.

## Status line

Configure under **Settings → Appearance → Status Line** (`/statusline` jumps to this group), or in `config.yml`:

| Key | Purpose |
| --- | --- |
| `statusLine.preset` | `default`, `minimal`, `compact`, `full`, `nerd`, `ascii`, or `custom` |
| `statusLine.leftSegments` / `statusLine.rightSegments` | Segment lists when `preset: custom` |
| `statusLine.separator` | `powerline`, `pipe`, `slash`, `block`, `none`, `ascii`, … |
| `statusLine.sessionAccent` | Color the bar from the session accent |
| `statusLine.showHookStatus` | Show active hook status when hooks run |

Built-in segment IDs include: `pi` (legacy product mark segment), `profile`, `model`, `mode`, `path`, `git`, `pr`, `subagents`, `token_in`, `token_out`, `token_total`, `token_rate`, `cost`, `context_pct`, `context_total`, `time_spent`, `time`, `session`, `hostname`, `cache_read`, `cache_write`, `cache_hit`, `session_name`, `usage`, `collab`.

The `model` segment shows the model you are working with, then two things that are easy to confuse, so they are drawn differently:

- The **thinking effort** joins the model label as one unit (`Sonnet 4.5 @high` in the quiet footline, `Sonnet 4.5 · high` elsewhere), in the model's own color. It is how much reasoning the model does per turn. Change it with `/thinking` (its alias is `/effort`), or set a per-model default under Settings → Model → Default Effort.
  The effort picker has a **Default** row followed by only the active model's valid variants. Choose Default to clear the session override and return to the saved per-model effort or the model default.
- The **priority tier** follows the effort as its own chip, named and in the warning color (`⚡ priority`, or just `priority` when your symbol preset has no icon). It is how your requests are queued and served, not how deeply the model thinks. Toggle it with `/fast`, or set it per provider family under Settings → Model → Service Tier.

The `git` segment shows the current branch, and appends the multi-step operation you are part-way through when there is one:

```
main                 on a branch, nothing in progress
detached             detached HEAD
topic|REBASE         rebasing topic
main|MERGE           a merge that stopped on a conflict
main|CHERRY-PICK     a cherry-pick that stopped on a conflict
main|REVERT          a revert that stopped on a conflict
main|AM              applying a patch series with git am
detached|BISECT      bisecting
```

A rebase detaches HEAD, so without the suffix the segment could only say `detached`, which tells you neither which branch you are rebasing nor that a rebase is running. Veyyon reads the branch back from the rebase's own record, so you see `topic|REBASE`. A merge is the opposite case: it leaves HEAD on its branch, so the segment would look like an ordinary checkout while your working tree holds conflict markers. The suffix is what distinguishes them.

The `pr` segment is skipped while any of these operations is in progress. A branch being rebased does not yet point where it is going to end up, so a pull request looked up against it would describe a state that is about to be replaced.

The `profile` segment shows the active profile name (`work`, `rec`, a client sandbox), so you always know which profile's config, sessions, and keys are live. It hides itself on the built-in `default` profile, so an unconfigured status line stays clean. Every built-in preset places it, so switching profiles is visible without any configuration.

The `context_pct` segment answers one question: how much room is left before the context runs out. "Runs out" means whichever comes first, auto-compaction firing or the model's window filling, so with auto-compaction on the segment measures against the compaction trigger, not the window. The window itself is what `context_total` prints.

In the composer's quiet footline the segment renders as an 8-cell bar with a labelled percentage: `▰▰▰▰▰▰▱▱ 76% left ∞`. The bar drains, one cell per eighth of the room remaining, so the bar and the number always agree. Filled cells take the usage hue (silver, then gold, ember, and red as room runs out). While the model is running, the last remaining cell pulses between filled and empty, faster once you are past 90 percent used; at rest the bar never moves, so an idle screen is still. A session-accent `∞` after the bar means auto-compaction is on, so the session continues past the trigger.

Classic status-line presets render the same measurement as text, in tokens on both sides of the slash: `47K/170K`. For a full picture of what is in the window, and how it is divided between the system prompt, tools, skills, and messages, run `/context`.

Two run clocks tick alongside the segments, both measuring model runtime, never idle wall time. While the agent runs, the location line (path and git branch) ends with the current run's elapsed, in `M:SS` form and widening to `H:MM:SS` past the hour: `…keyhog  ·  main *      12:34`. When the run finishes the clock freezes as `✓ 12:34` (checkmark plus the final `M:SS`/`H:MM:SS` readout); before the model has ever started it shows nothing. The working line shows how long the current step has been running, between the step label and the esc hint: `Running tests · 0:42 ⟦esc⟧`; that clock restarts whenever the step changes. The `time_spent` segment is related but cumulative: it sums every run in the session (a fresh session with `/new` starts it at zero) and appears in the `full` and `nerd` presets.

## Session tree and agents

| Command | Effect |
| --- | --- |
| `/tree` | Browse the session entry tree; jump or label entries |
| `/branch` | Branch a new session file from an earlier user message |
| `/fork` | Duplicate the current session into a new file |
| `/session info` | Session metadata and stats |
| `/agents` | Agent Control Center: the live roster (agent type, status, activity; Enter opens one agent's session) and the Comms stream of agent-to-agent messages |
| `/jobs` | List background async tool jobs |

`/cockpit` and `/hub` are aliases of `/agents`, as is the `app.agents.hub` keybinding and a double-tap of the left arrow on an empty composer. They used to open a separate screen with its own roster and its own drill-in, which meant "which agents are running" had two answers that could disagree with each other. They all open the one card now.

### The Live roster

Each row is one agent that exists right now: a status glyph, its call sign, the TYPE of agent it was spawned from (`reviewer`, `scout`), its status, how long since it last did anything, and what it is doing. Rows sit in spawn order, oldest first, with your own session at the top. The row you are on is marked two ways, a cursor glyph in the first column and a band across the whole row, so it stays readable on a terminal that renders no colour. Agents from earlier runs of the same session appear too, marked `parked`, because their transcripts are still on disk even though this process never started them.

Press Enter on a row and the main view becomes that agent's session: the transcript, the composer, and the status line all point at it, so you read what it is doing and then answer it. Press Esc there to come back to your own session. Opening a parked agent revives it on the way in.

To terminate a subagent, select its row and press `x`, or hover the row and click the `[x]` at its right edge. Both gestures open the same confirmation card. Choose **Dismiss** to return without changing the agent, or choose **Yes, terminate** to abort any turn in flight and release the session. The transcript stays on disk. Your main session and read-only advisor transcripts do not show the termination action.

Clicking elsewhere on a row does the same thing as Enter, and clicking a name in the view strip switches to that view. Opening an agent is reversible with Esc, so a row click opens rather than only moving the cursor. The scroll wheel moves whatever the arrow keys move: the roster cursor on Live, the stream on Comms. Page up and page down move by a screenful, on either view.

The roster is a table, so you can scan a column instead of reading every row: the status, the age, the model and the activity each start at the same place on every line. A name long enough to crowd the row out is truncated rather than paid for by every other row, and the model badge is dropped when the card is too narrow to show enough of it to recognise.

Two agents open a read-only transcript instead of handing the main view over. An advisor is observability-only and is not an addressable peer, so there is nothing on the other end to receive a reply. A collab guest's agents live on the host, so there is no local session to point at.

The inline task widget also shows the model each subagent runs on, right in its status line, so you can see which model every launched subagent used without opening the Control Center. The `Subagents` block above the composer in your main session shows the same badge on every running row, so the answer to "what is that one running on" is on screen without opening anything. To show the badge, keep `subagent.showResolvedModelBadge` on (Subagents settings); turning it off hides it on all three surfaces.

Session files are append-only JSONL under the active profile’s agent `sessions/` directory. See [Sessions](../using/sessions.md).

## Inter-agent messaging

Subagents and the main agent use the `irc` tool (`send`, `wait`, `inbox`, `list`) over a process-global mailbox. The **Comms** view of `/agents` streams that traffic as it happens, oldest first, including the messages that failed to reach their recipient and the reason they did not land. Long messages are folded to their first few lines with a count of what was hidden; `ctrl+o` unfolds every message in the view, and pressing it again folds them back. Both ends of a message are labelled with the call sign the Live roster shows for that agent, so you follow a conversation by who is speaking rather than by an id you have to look up on the other view. An agent that has since been released has no call sign left to show, so its messages print its id instead.

The view reads the message bus, not the session files. A subagent's transcript records what THAT agent received, so a view built from transcripts would show each half of a conversation in a different file and would never show a message that failed to arrive at all. `/btw` is an ephemeral side question; `/tan` spawns a background agent for tangential work. (`/omfg` is unrelated: it forges a TTSR rule from a complaint to stop a recurring behavior.)

## Swarm extension

`@veyyon/swarm-extension` runs multi-agent DAG workflows from YAML (`pipeline`, `parallel`, or `sequential`). Standalone: `veyyon-swarm path/to/swarm.yaml`. In the TUI, add the package to `extensions`, then:

```text
/swarm run path/to/swarm.yaml
/swarm status <name>
/swarm help
```

State and logs: `<workspace>/.swarm_<name>/` (`state/pipeline.json`, `logs/*.log`).
