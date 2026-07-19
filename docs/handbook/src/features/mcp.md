# MCP

You point Veyyon at an external program (a database bridge, a browser driver, a hosted API) and its
tools show up in the session, ready for the model to call. The Model Context Protocol (MCP) is the
standard that makes this work. Veyyon speaks it as a client: it connects out to MCP servers and
consumes their tools and data. It is not itself an MCP server binary. To embed Veyyon in an editor,
use ACP (`veyyon acp`); to drive it from your own process, use the SDK.

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
| User | `~/.veyyon/profiles/default/agent/mcp.json` |

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

## Related surfaces (not MCP server mode)

- **ACP** (`veyyon acp`): Agent Client Protocol for editors; not MCP.
- **SDK**: embed the agent in a host process.

MCP config remains `mcp.json` and `/mcp`.
