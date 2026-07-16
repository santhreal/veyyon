# Cockpit: monitoring multi-agent work

Veyyon's interactive TUI is the primary cockpit. Today it shows one session at a time with a
configurable status line, session tree navigation, background jobs, and optional swarm orchestration.
A full IRC-style live multi-agent dashboard (model-per-subagent, drill-in panels) is not shipped yet.

## Status line (built)

The bottom status bar summarizes model, path, git, tokens, cost, context, subagents, and related
session state. Configure it in **Settings → Appearance → Status Line**, reached via `/statusline`
(jumps straight to this group) or `/settings`, or in `config.yml`:

| Key | Purpose |
| --- | --- |
| `statusLine.preset` | `default`, `minimal`, `compact`, `full`, `nerd`, `ascii`, or `custom` |
| `statusLine.leftSegments` / `statusLine.rightSegments` | Segment lists when `preset: custom` |
| `statusLine.separator` | `powerline`, `pipe`, `slash`, `block`, `none`, `ascii`, … |
| `statusLine.sessionAccent` | Color the bar from the session accent |
| `statusLine.showHookStatus` | Show active hook status when hooks run |

There are 24 built-in segment IDs (`StatusLineSegmentId`): `pi`, `model`, `mode` (plan/goal/loop
indicators), `path`, `git`, `pr`, `subagents`, `token_in`, `token_out`, `token_total`,
`token_rate`, `cost`, `context_pct`, `context_total`, `time_spent`, `time`, `session`, `hostname`,
`cache_read`, `cache_write`, `cache_hit`, `session_name`, `usage`, and `collab`.

**Shipped today:** `/statusline` opens Settings pre-focused on the Status Line group (preset,
separator, and toggles), and `preset: custom` + `leftSegments`/`rightSegments` in `config.yml` give
full control over which of the 24 IDs appear and in what order.

> **Spec — not shipped:** an in-TUI interactive picker that lets you toggle/reorder individual
> segment IDs without hand-editing `config.yml` (no per-segment checkbox/drag UI exists), a terminal
> title composer (`/title`), and terminal pets (`/pets`).

## Session tree and branching (built)

| Command | What it does |
| --- | --- |
| `/tree` | Browse the session entry tree and jump or label entries |
| `/branch` | Pick an earlier user message and branch a new session file from it |
| `/fork` | Duplicate the entire current session into a new file (no entry picker) |
| `/session info` | Session metadata and stats |
| `/agents` | Configure task subagent definitions (bundled/project/user) |
| `/cockpit` | Live multi-agent monitor: status, model per agent, drill-in transcript |
| `/jobs` | List background async tool jobs |

Session files are append-only JSONL trees under `~/.veyyon/agent/sessions/`. See
[Sessions](../using/sessions.md).

## Inter-agent messaging (built)

Subagents and the main agent can use the `irc` tool (`send`, `wait`, `inbox`, `list`) over a
process-global mailbox. `/btw` runs an ephemeral side question; `/tan` and `/omfg` spawn background
agents for tangential work.

## Swarm extension (built)

`@veyyon/swarm-extension` runs multi-agent DAG workflows from YAML: `pipeline`, `parallel`, or
`sequential` modes. Each agent is a full subagent with normal tools.

**Standalone:** `veyyon-swarm path/to/swarm.yaml` (bin from `@veyyon/swarm-extension`).

**In the TUI:** add the package to `extensions`, then:

```
/swarm run path/to/swarm.yaml
/swarm status <name>
/swarm help
```

State and logs persist under `<workspace>/.swarm_<name>/` (`state/pipeline.json`, `logs/*.log`).

## IRC-style live cockpit

**Shipped:** `/cockpit` (alias `/hub`) opens the Agent Hub overlay: every registered agent except Main,
with status, unread IRC count, model badge, and drill-in transcript chat. Same surface as the
`app.agents.hub` keybinding.

**Spec — not shipped:** full IRC-style dashboard with channel tabs, terminal title composer, and an
interactive per-segment status-line picker (`/statusline` opens settings, not a picker — see
above). Use `/cockpit`, `/jobs`, `/tree`, swarm status files, and the `irc` tool for multi-agent
visibility today.
