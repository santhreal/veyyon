# Export and import

## Session export (built)

`/export` writes the current session transcript. Target format depends on the extension:

| Target | Format |
| --- | --- |
| `.jsonl` or default | Native session JSONL (append-only entries) |
| `.html` / `.htm` | Standalone offline HTML transcript |

Paths resolve relative to the working directory, `~/`, or absolute paths. Directory targets receive
the default session filename inside the folder.

## Migration from Claude Code (built)

`/import` is **not** in the builtin slash registry; Claude migration may be available through setup
flows or extensions. When import runs, it merges compatible settings from `.claude/` into Veyyon's
config tree (`.veyyon/`, `~/.veyyon/agent/`), including MCP, hooks, skills, and agents.

Import works on **local** sessions; no background daemon is required.

Typical migrated items:

- Settings from `.claude/settings.json` → `config.yml`
- MCP servers → `mcp.json`
- Hooks → `.veyyon/hooks.json` or extension hooks
- Skills → `.agents/skills` / `.veyyon/skills`
- Subagents → `.veyyon/agents`
- `CLAUDE.md` → `AGENTS.md`

See [Migration guide](../using/migration-guide.md).
