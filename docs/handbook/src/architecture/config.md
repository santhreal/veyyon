# Config

Configuration controls models, approvals, memory, MCP, extensions, and TUI behavior. Veyyon loads
layered YAML/JSON from the project and user agent directories.

## Responsibility

- Resolve config roots (`.veyyon`, plus Claude/Codex/Gemini compatibility paths)
- Merge project + user settings; apply **profiles** (`veyyon --profile <name>`)
- Validate against `settings-schema.ts`; support CLI `-c key=value` overrides
- Feed resolved settings to sessions, tools, and discovery (skills, hooks, MCP, extensions)

## Public boundary

- Primary user file: `~/.veyyon/profiles/default/agent/config.yml` (or profile path under `~/.veyyon/profiles/`)
- Project overrides: `.veyyon/config.yml`
- CLI: `veyyon config list|get|set`, `/settings`, `/reload-plugins` (re-read without restart)

Config loading is part of the harness.

Operator guide: [Configuration](../using/configuration.md).

Engineering detail: [`docs/config-usage.md`](../../../config-usage.md),
[`docs/settings.md`](../../../settings.md).
