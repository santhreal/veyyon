# MCP

Model Context Protocol (MCP) lets Veyyon connect to external tools and data sources. Veyyon is an MCP
**client** by default; agent control protocol (ACP) and SDK paths can expose Veyyon as a server.

## Transports

| Transport | Use when |
| --- | --- |
| `stdio` | Local executable (Node, Python, binary) |
| HTTP / SSE | Remote hosted MCP service |

## Configure servers

**Preferred:** JSON files managed by Veyyon:

| Scope | Path |
| --- | --- |
| Project | `.veyyon/mcp.json` |
| User | `~/.veyyon/agent/mcp.json` |

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/santhreal/veyyon/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "sqlite": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/sqlite-mcp/index.js"],
      "env": { "DB_PATH": "/var/data/app.db" }
    }
  }
}
```

Veyyon also discovers MCP entries from Claude, Cursor, VS Code, OpenCode, and related tool configs.

Setup walkthrough: [MCP server setup](../using/mcp-setup.md).

Engineering detail: [`docs/mcp-config.md`](../../../mcp-config.md).

## In the TUI

| Command | Purpose |
| --- | --- |
| `/mcp` | List servers, connection/auth status, exposed tools |
| `/mcp add` | Add a server (wizard) |
| `/mcp list` | List configured servers |
| `/mcp remove <name>` | Remove a server |
| `/mcp test <name>` | Test connectivity |
| `/mcp reauth <name>` | Refresh OAuth |

Tool names appear namespaced as `mcp__<server>__<tool>`.

## Running Veyyon as an MCP server

Use the ACP integration or SDK embedding rather than a separate `veyyon mcp-server` subcommand unless
your build registers it.

Veyyon configures MCP through `mcp.json` and the `/mcp` command.
