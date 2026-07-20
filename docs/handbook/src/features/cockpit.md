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

Built-in segment IDs include: `pi` (legacy product mark segment), `model`, `mode`, `path`, `git`, `pr`, `subagents`, `token_in`, `token_out`, `token_total`, `token_rate`, `cost`, `context_pct`, `context_total`, `time_spent`, `time`, `session`, `hostname`, `cache_read`, `cache_write`, `cache_hit`, `session_name`, `usage`, `collab`.

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
