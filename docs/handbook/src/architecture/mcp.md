# MCP

Model Context Protocol (MCP) connects Veyyon to external tools and data as an MCP **client**
(consumes configured servers). Editor embedding uses ACP (`veyyon acp`), a different protocol.

## Responsibility

- Discover MCP servers from the operator's user and profile config files
- Connect over **stdio** or **HTTP** (streamable HTTP / SSE-style transports)
- Register tools as namespaced names (`mcp__<server>_<tool>`, e.g. `mcp__filesystem_delete`)
- Handle OAuth for remote servers and persist credentials per profile

## Implementation (TypeScript)

| Module | Role |
| --- | --- |
| `packages/coding-agent/src/mcp/` | Config load, manager, OAuth, tool wiring |
| `packages/coding-agent/src/discovery/builtin.ts` | Profile-scoped `mcp.json` / `.mcp.json` discovery |
| `packages/coding-agent/src/modes/controllers/mcp-command-controller.ts` | `/mcp` TUI commands |

Primary config files:

- User: `~/.veyyon/profiles/default/agent/mcp.json` (profile-scoped when using `--profile`)

There is no project scope. A checked-out working tree is untrusted input, so
`<cwd>/.veyyon/mcp.json`, a repo-root `mcp.json`/`.mcp.json`, and the foreign
`.cursor/mcp.json` and `.vscode/mcp.json` are no longer read.

Veyyon also ingests MCP definitions from other tools' USER-level configs
(`~/.claude`, `~/.codex`, `~/.gemini`, `~/.cursor`) when discovery is enabled.

A config file that exists but does not parse is REPORTED, never skipped: the
`native` provider raises `Failed to parse JSON in <path>` through the capability
warning channel, which `MCPManager.discoverAndConnect` puts on its status stream
and `/mcp list` and the boot health zone render. Before that, a mistyped comma in
`mcp.json` produced a session with every configured server missing and no line
anywhere saying why.

User guide: [MCP](../features/mcp.md), [MCP setup](../using/mcp-setup.md).

Engineering detail:
[`docs/mcp-config.md`](../../../mcp-config.md),
[`docs/internal/mcp-runtime-lifecycle.md`](../../../internal/mcp-runtime-lifecycle.md),
[`docs/internal/mcp-protocol-transports.md`](../../../internal/mcp-protocol-transports.md).
