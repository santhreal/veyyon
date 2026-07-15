# Cockpit: monitoring multi-agent work

Veyyon's interactive TUI is the primary cockpit. Today it shows one session at a time with a
configurable status line, session tree navigation, background jobs, and optional swarm orchestration.
A full IRC-style live multi-agent dashboard (model-per-subagent, drill-in panels) is not shipped yet.

## Status line (built)

The bottom status bar summarizes model, path, git, tokens, cost, context, subagents, and related
session state. Configure it in **Settings → Appearance → Status Line** (`/settings`) or in
`config.yml`:

| Key | Purpose |
| --- | --- |
| `statusLine.preset` | `default`, `minimal`, `compact`, `full`, `nerd`, `ascii`, or `custom` |
| `statusLine.leftSegments` / `statusLine.rightSegments` | Segment lists when `preset: custom` |
| `statusLine.separator` | `powerline`, `pipe`, `slash`, `block`, `none`, `ascii`, … |
| `statusLine.sessionAccent` | Color the bar from the session accent |
| `statusLine.showHookStatus` | Show active hook status when hooks run |

Built-in segment IDs include `model`, `path`, `git`, `pr`, `subagents`, `context_pct`,
`token_in`, `token_out`, `token_total`, `token_rate`, `cost`, `usage`, `collab`, `mode`
(plan/goal/loop indicators), `session`, `session_name`, `time`, and `hostname`.

> **Spec — not shipped:** an interactive `/statusline` picker with 28 toggleable item IDs, a terminal
> title composer (`/title`), and terminal pets (`/pets`). Veyyon uses preset-based status lines only.

## Session tree and branching (built)

| Command | What it does |
| --- | --- |
| `/tree` | Browse the session entry tree and jump or label entries |
| `/branch` | Start a branch from the current leaf |
| `/fork` | Fork from an earlier message |
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

**Spec — not shipped:** full IRC-style dashboard with channel tabs, terminal title composer, and
28-segment interactive `/statusline` picker. Use `/cockpit`, `/jobs`, `/tree`, swarm status files,
and the `irc` tool for multi-agent visibility today.
