# MCP server setup

Veyyon can connect to third-party Model Context Protocol (MCP) servers so external tools and data
sources become available to the agent. This guide explains how to register those servers, choose a
transport, authenticate, and fix the most common connection problems.

For an overview of what MCP does in Veyyon, see [MCP](../features/mcp.md). Engineering reference:
[`docs/mcp-config.md`](../../../mcp-config.md).

## Where servers are configured

MCP servers are configured as **JSON** in `mcp.json`, not in `config.yml`:

| Scope | Path |
| --- | --- |
| Project | `.veyyon/mcp.json` |
| User | `~/.veyyon/profiles/default/agent/mcp.json` (profile: `~/.veyyon/profiles/<name>/agent/mcp.json`) |

Veyyon also discovers MCP entries from Claude, Cursor, VS Code, and OpenCode configs. The easiest way
to add a server is `/mcp add` in the TUI, which writes to `mcp.json` for you.

## File shape

```json
{
  "$schema": "https://raw.githubusercontent.com/santhreal/veyyon/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "sqlite": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/sqlite-mcp-server/index.js"]
    }
  },
  "disabledServers": []
}
```

Top-level keys: `mcpServers` (map of name to config) and `disabledServers` (names to turn off). Server
names match `^[a-zA-Z0-9_.-]{1,100}$`. Shared per-server fields: `enabled`, `timeout` (milliseconds;
`0` disables the client-side timeout), `auth`, and `oauth`.

## Choose a transport

| `type` | Use when | Fields |
| --- | --- | --- |
| `stdio` (default) | Local executable, script, or binary. | `command` (required), `args`, `env`, `cwd` |
| `http` | Remote streamable-HTTP service. | `url` (required), `headers` |
| `sse` | Legacy SSE service (prefer `http`). | `url` (required), `headers` |

`type` is optional for stdio because it is inferred from `command`.

A minimal streamable HTTP server:

```json
{
  "mcpServers": {
    "analytics": {
      "type": "http",
      "url": "https://analytics.example.com/mcp"
    }
  }
}
```

## Pass environment variables

Local stdio servers often need environment variables:

```json
{
  "mcpServers": {
    "sqlite": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/sqlite-mcp-server/index.js"],
      "env": { "DB_PATH": "/var/data/app.db", "SQLITE_LOG_LEVEL": "warn" }
    }
  }
}
```

For HTTP servers, pass credentials or account ids as headers:

```json
{
  "mcpServers": {
    "analytics": {
      "type": "http",
      "url": "https://analytics.example.com/mcp",
      "headers": { "Authorization": "Bearer ${ANALYTICS_MCP_TOKEN}", "X-Account-Id": "acct_123" }
    }
  }
}
```

## Authenticate

### Bearer token via header

Keep the token in the environment and reference it from a header rather than committing the raw value:

```console
$ export ANALYTICS_MCP_TOKEN="your-token-value"
```

### OAuth

Some HTTP servers require an interactive OAuth flow. Add an `oauth` block, then authenticate from the
TUI with `/mcp reauth <name>`:

```json
{
  "mcpServers": {
    "crm": {
      "type": "http",
      "url": "https://crm.example.com/mcp",
      "oauth": { "clientId": "veyyon-crm-client" }
    }
  }
}
```

## Approve tools

Every tool an MCP server exposes appears namespaced as `mcp__<server>__<tool>` and is governed by the
global `tools.approvalMode` plus per-tool `tools.approval`. To require a prompt for a specific server's
tools, set a per-tool policy:

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
tools:
  approval:
    mcp__sqlite__query: prompt
```

To turn a server off entirely, add its name to `disabledServers` in `mcp.json`.

## In the TUI

| Command | Purpose |
| --- | --- |
| `/mcp` | List servers, connection/auth status, and exposed tools |
| `/mcp add` | Add a server (writes `mcp.json`) |
| `/mcp list` | List configured servers |
| `/mcp remove <name>` | Remove a server |
| `/mcp test <name>` | Test connectivity |
| `/mcp reauth <name>` | Refresh OAuth |

Run `/mcp verbose` to see exactly which tools, resources, and templates Veyyon registered.

## Resolve common errors

### Server not found

For a `stdio` server, the command is usually not on `PATH` or the path is wrong. Check it directly:

```console
$ node /path/to/sqlite-mcp-server/index.js
```

Fix the path, or add the directory to `env.PATH`. For an `http` server, check the URL with curl:

```console
$ curl -i https://analytics.example.com/mcp
```

### Timeout

If `/mcp` shows the server but tool calls time out, raise the per-server `timeout` (milliseconds), or
set `VEYYON_MCP_TIMEOUT_MS` for the whole process:

```json
{ "mcpServers": { "analytics": { "type": "http", "url": "…", "timeout": 60000 } } }
```

### Authentication failure

For header tokens, confirm the environment variable is set in the same shell that starts Veyyon. For
OAuth, run `/mcp reauth <name>` again. If a 401/403 persists, the token may have expired or the server
may require additional headers.

### Model cannot see the tools

If a server is connected but the model never uses its tools, check that the server is not in
`disabledServers`, that `enabled` is not `false`, and that no `tools.approval` entry denies the
namespaced tool. Run `/mcp verbose` to see what was registered.

## Where to go next

- [MCP](../features/mcp.md) for the feature overview (MCP client; ACP is separate).
- [Configuration](./configuration.md) for config file layout and precedence.
- [Tools, skills, and extension data](./extending.md) for other ways to extend Veyyon.
