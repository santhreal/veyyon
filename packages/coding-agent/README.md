# @veyyon/coding-agent

Core implementation package for the `veyyon` coding agent in the veyyon monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:
- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/santhreal/veyyon#readme)

Package-specific references:
- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/internal/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/internal/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Memory backends

Memory backends are selected via `memory.backend` (Settings → Memory, or profile `config.yml` under `~/.veyyon/profiles/default/agent/`):

- `off` (default) — no memory subsystem runs.
- `local` — rollout summarization; writes `memory_summary.md` and related artifacts under the agent dir.
- `mnemopi` — local SQLite engine via `@veyyon/mnemopi` (vector + FTS, auto-retain, compaction hooks).
- `hindsight` — [Hindsight](https://hindsight.vectorize.io) server (cloud or self-hosted), retain/recall/reflect tools.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session is honoured on the next system-prompt rebuild and the next `/memory` slash command. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch.
