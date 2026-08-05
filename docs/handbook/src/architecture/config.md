# Config

Configuration controls models, approvals, memory, MCP, extensions, and TUI behavior. Veyyon loads
layered YAML/JSON from the user agent directories. A working tree never supplies configuration:
a checked-in `.veyyon/config.yml` is not read, because a repository is content you may not have
written.

## Responsibility

- Resolve config roots (the active profile's agent dir, plus Claude/Codex/Gemini compatibility paths at user level)
- Merge profile settings with `--config` overlays and runtime overrides; apply **profiles** (`veyyon --profile <name>`)
- Validate against `settings-schema.ts`; support `--config <file>` YAML overlay files (repeatable)
- Feed resolved settings to sessions, tools, and discovery (skills, hooks, MCP, extensions)

## Public boundary

- Primary user file: `~/.veyyon/profiles/default/agent/config.yml` (or profile path under `~/.veyyon/profiles/`)
- CLI: `veyyon config list|get|set`, `/settings`, `/reload-plugins` (re-read without restart)

Config loading is part of the harness.

Operator guide: [Configuration](../using/configuration.md).

Engineering detail: [`docs/config-usage.md`](../../../config-usage.md),
[`docs/settings.md`](../../../settings.md).
