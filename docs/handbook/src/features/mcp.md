# MCP

You point Veyyon at an external program (a database bridge, a browser driver, a hosted API) and its
tools show up in the session, ready for the model to call. The Model Context Protocol (MCP) is the
standard that makes this work. Veyyon speaks it as a client: it connects out to MCP servers and
consumes their tools and data. It is not itself an MCP server binary. To embed Veyyon in an editor,
use ACP (`veyyon acp`); to drive it from your own process, use the SDK.

## What it looks like

You register a server in an `mcp.json` file, and its tools become callable. A minimal local server:

```json
{
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

Each tool an MCP server exposes appears namespaced as `mcp__<server>__<tool>`, so a server never
shadows a built-in tool or another server. Veyyon also discovers MCP entries that Claude, Cursor, VS
Code, OpenCode, and related tools already wrote, so a server you configured elsewhere often works
without re-registering it.

For the full setup path, choosing a transport (`stdio`, `http`, `sse`), passing environment
variables, authenticating (bearer token or OAuth), approving tools, the `/mcp` commands, and fixing
common connection errors, see [MCP server setup](../using/mcp-setup.md).

## Not to be confused with

- **ACP** (`veyyon acp`): the Agent Client Protocol for driving Veyyon from an editor. That makes
  Veyyon the agent an editor talks to; MCP makes Veyyon the client that talks to tool servers.
- **SDK**: embedding the agent in your own host process.

## Related

- [MCP server setup](../using/mcp-setup.md): the configuration and troubleshooting guide
- [MCP internals](../architecture/mcp.md): how the client is built
- [`docs/mcp-config.md`](../../../mcp-config.md): the engineering reference
