# Multi-agent monitoring

The interactive TUI is the main surface for one session. Status line, session tree, background jobs, `/cockpit`, and optional swarm orchestration cover multi-agent work.

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

The `profile` segment shows the active profile name (`work`, `rec`, a client sandbox), so you always know which profile's config, sessions, and keys are live. It hides itself on the built-in `default` profile, so an unconfigured status line stays clean. Every built-in preset places it, so switching profiles is visible without any configuration.

In the composer's quiet footline the `context_pct` segment renders as a growing 8-cell bar instead of the `pct/window` text: `▰▰▰▓▱▱▱▱ 38% ∞`. Filled cells take the usage hue (silver, then gold, ember, and red as the window fills), and cells at the 25/50/75/90 percent marks lock in gold once reached. The cell at the fill frontier breathes while the model is running (faster once usage passes 90 percent); at rest it is a static quarter-step glyph showing how full the next cell is, so an idle screen never moves. The percent number stays; the window denominator moves to the `context_total` segment. A session-accent `∞` after the bar means auto-compaction is on, so the session continues past the window. Classic status-line presets keep the text form.

Two run clocks tick alongside the segments, both measuring model runtime, never idle wall time. While the agent runs, the location line (path and git branch) ends with the current run's elapsed, in `M:SS` form and widening to `H:MM:SS` past the hour: `…keyhog  ·  main *      12:34`. When the run finishes it reads `Worked for 12m34s` and freezes; before the model has ever started it shows nothing. The working line shows how long the current step has been running, between the step label and the esc hint: `Running tests · 0:42 ⟦esc⟧`; that clock restarts whenever the step changes. The `time_spent` segment is related but cumulative: it sums every run in the session (a fresh session with `/new` starts it at zero) and appears in the `full` and `nerd` presets.

## Session tree and agents

| Command | Effect |
| --- | --- |
| `/tree` | Browse the session entry tree; jump or label entries |
| `/branch` | Branch a new session file from an earlier user message |
| `/fork` | Duplicate the current session into a new file |
| `/session info` | Session metadata and stats |
| `/agents` | Task subagent definitions (bundled/project/user) |
| `/cockpit` | Live multi-agent monitor: status, model per agent, drill-in transcript (alias `/hub`; keybinding `app.agents.hub`) |
| `/jobs` | List background async tool jobs |

The inline task widget also shows the model each subagent runs on, right in its status line, so you can see which model every launched subagent used without opening the cockpit. To hide it, turn off `task.showResolvedModelBadge` (Appearance settings).

Session files are append-only JSONL under the active profile’s agent `sessions/` directory. See [Sessions](../using/sessions.md).

## Inter-agent messaging

Subagents and the main agent use the `irc` tool (`send`, `wait`, `inbox`, `list`) over a process-global mailbox. `/btw` is an ephemeral side question; `/tan` and `/omfg` spawn background agents for tangential work.

## Swarm extension

`@veyyon/swarm-extension` runs multi-agent DAG workflows from YAML (`pipeline`, `parallel`, or `sequential`). Standalone: `veyyon-swarm path/to/swarm.yaml`. In the TUI, add the package to `extensions`, then:

```text
/swarm run path/to/swarm.yaml
/swarm status <name>
/swarm help
```

State and logs: `<workspace>/.swarm_<name>/` (`state/pipeline.json`, `logs/*.log`).
