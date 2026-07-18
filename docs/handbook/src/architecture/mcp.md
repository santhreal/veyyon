# MCP

Model Context Protocol (MCP) connects Veyyon to external tools and data as an MCP **client**
(consumes configured servers). Editor embedding uses ACP (`veyyon acp`), a different protocol.

## Responsibility

- Discover MCP servers from project and user config files
- Connect over **stdio** or **HTTP** (streamable HTTP / SSE-style transports)
- Register tools as namespaced names (`mcp__<server>__<tool>`)
- Handle OAuth for remote servers and persist credentials per profile

## Implementation (TypeScript)

| Module | Role |
| --- | --- |
| `packages/coding-agent/src/mcp/` | Config load, manager, OAuth, tool wiring |
| `packages/coding-agent/src/discovery/mcp-json.ts` | Standalone `mcp.json` discovery |
| `packages/coding-agent/src/modes/controllers/mcp-command-controller.ts` | `/mcp` TUI commands |

Primary config files:

- Project: `.veyyon/mcp.json`
- User: `~/.veyyon/profiles/default/agent/mcp.json` (profile-scoped when using `--profile`)

Veyyon also ingests MCP definitions from other tools (`.cursor/mcp.json`, `.vscode/mcp.json`,
Claude/Codex/Gemini configs) when discovery is enabled.

User guide: [MCP](../features/mcp.md), [MCP setup](../using/mcp-setup.md).

Engineering detail:
[`docs/mcp-config.md`](../../../mcp-config.md),
[`docs/internal/mcp-runtime-lifecycle.md`](../../../internal/mcp-runtime-lifecycle.md),
[`docs/internal/mcp-protocol-transports.md`](../../../internal/mcp-protocol-transports.md).
