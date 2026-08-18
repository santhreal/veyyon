# MCP configuration in Veyyon

This guide explains how to add, edit, and validate MCP servers for the Veyyon coding agent.

Source of truth in code:

- Runtime config types: `packages/coding-agent/src/mcp/types.ts`
- Config writer: `packages/coding-agent/src/mcp/config-writer.ts`
- Loader + validation: `packages/coding-agent/src/mcp/config.ts`
- Capability providers (the editor configs Veyyon also reads): `packages/coding-agent/src/discovery/`
- Schema: `packages/coding-agent/src/config/mcp-schema.json`

## Where MCP config lives

Veyyon-native MCP config lives in exactly one file, the active profile's agent directory:

- `~/.veyyon/profiles/default/agent/mcp.json`
- `~/.veyyon/profiles/<name>/agent/mcp.json` when a named profile is active (see [Profiles](#profiles))

The native provider also reads `.mcp.json` beside it for compatibility, but Veyyon writes to `mcp.json`.

There is no project scope, and no `/mcp` subcommand takes a scope at all. `.veyyon/mcp.json`, a root
`mcp.json` and a root `.mcp.json` inside a working tree used to be loaded and used to be writable
through `/mcp add --scope project`; none of them is read now, and neither the option spelling nor the
plain words `project` and `user` are accepted. Both are refused with the reason, on the text surface
as well as in the terminal: the text handler kept the scope after the terminal dropped it, defaulted
to it, and wrote a file nothing loads while reporting success. A repository is content you may not
have written, so a checked-in file must not name a server the agent connects to or a command it
spawns. Veyyon still discovers servers from other tools' user-level configs (`~/.claude.json`,
`~/.claude/mcp.json`, `~/.cursor/mcp.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`,
opencode, windsurf, and more), always from your home directory, never from a working tree, and
`/mcp list` names the file each server came from.

### Profiles

Named profiles (`veyyon --profile <name>`, the `--alias` shortcut, or `VEYYON_PROFILE` still work) isolate MCP config. When a profile is active, `mcp.json` resolves to that profile's agent directory:

- Default profile: `~/.veyyon/profiles/default/agent/mcp.json`
- Profile `<name>`: `~/.veyyon/profiles/<name>/agent/mcp.json`

Discovery, the `/mcp` commands, and the config writer all follow the active profile, so a profile sees **only** its own servers, never the default profile's `~/.veyyon/profiles/default/agent/mcp.json`. Add a server to a profile by launching under it (`veyyon --profile <name>`) and running `/mcp add`, or by editing `~/.veyyon/profiles/<name>/agent/mcp.json` directly.

External-tool configs (`.claude/`, `.cursor/`, etc.) are profile-independent because they belong to those tools rather than to a Veyyon profile.

MCP follows the same profile rules as the rest of Veyyon-native config; see [Configuration Discovery → Profiles](./config-usage.md#profiles).

## Add a schema reference

Add this line at the top of the file for editor autocomplete and validation:

```json
{
  "$schema": "https://raw.githubusercontent.com/santhreal/veyyon/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {}
}
```

Veyyon now writes this automatically when `/mcp add`, `/mcp enable`, `/mcp disable`, `/mcp reauth`, or other config-writing flows create or update a Veyyon-managed MCP file.

## File shape

Veyyon supports this top-level structure:

```json
{
  "$schema": "https://raw.githubusercontent.com/santhreal/veyyon/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "some-mcp-server"]
    }
  },
  "disabledServers": ["server-name"]
}
```

Top-level keys:

- `$schema`: optional JSON Schema URL for tooling
- `mcpServers`: map of server name to server config
- `enabledServers`: user-level list that overrides a discovered server's `enabled: false` flag (for example when the source config is owned by another tool such as `opencode.json`); `disabledServers` still wins
- `disabledServers`: user-level denylist used to turn off discovered servers by name; runtime loading reads this list from the active profile's user MCP file (`~/.veyyon/profiles/default/agent/mcp.json`, or `~/.veyyon/profiles/<name>/agent/mcp.json` under a named profile)

Server names must match `^[a-zA-Z0-9_.-]{1,100}$`.

## Supported server fields

Shared fields for every transport:

- `enabled?: boolean`: skip this server when `false`
- `timeout?: number`: MCP request timeout in milliseconds; `0` disables client-side MCP timeouts
- `auth?: { ... }`: auth metadata used by Veyyon for OAuth/API-key flows
- `oauth?: { ... }`: explicit OAuth client settings used during auth/reauth

Set `VEYYON_MCP_TIMEOUT_MS=0` to disable the client-side timeout for every MCP server in the current process. Set it to a positive millisecond value, such as `VEYYON_MCP_TIMEOUT_MS=120000`, to apply one global timeout without editing each server entry.

### `stdio` transport

`stdio` is the default when `type` is omitted.

Required:

- `command: string`

Optional:

- `type?: "stdio"`
- `args?: string[]`
- `env?: Record<string, string>`
- `cwd?: string`

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/santhreal/veyyon/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/alice/projects",
        "/Users/alice/Documents"
      ]
    }
  }
}
```

This follows the official Filesystem MCP server package (`@modelcontextprotocol/server-filesystem`).

### `http` transport

Required:

- `type: "http"`
- `url: string`

Optional:

- `headers?: Record<string, string>`

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/santhreal/veyyon/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

This matches GitHub's hosted GitHub MCP server endpoint.

### `sse` transport

Required:

- `type: "sse"`
- `url: string`

Optional:

- `headers?: Record<string, string>`

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/santhreal/veyyon/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "legacy-remote": {
      "type": "sse",
      "url": "https://example.com/mcp/sse"
    }
  }
}
```

`sse` is still supported for compatibility, but the MCP spec now prefers Streamable HTTP (`type: "http"`) for new servers.

## Auth fields

Veyyon understands two auth-related objects.

### `auth`

```json
{
  "type": "oauth" | "apikey",
  "credentialId": "optional-stored-credential-id",
  "tokenUrl": "optional-token-endpoint",
  "clientId": "optional-client-id",
  "clientSecret": "optional-client-secret",
  "resource": "optional-mcp-resource-uri"
}
```

Use this when Veyyon should remember how to rehydrate credentials for a server.

You normally do not need to write this block: when Veyyon completes an OAuth flow
for an `http`/`sse` server it stores the credential under a deterministic id
derived from the active profile and server URL
(`mcp_oauth:profile:<profile>:<url>`), with the refresh material embedded. Any
config that points at the same URL, including a *definition-only* entry with no
`auth` block at all, resolves the active profile's own credential automatically,
including when auth storage is backed by a shared auth broker. An explicit
`credentialId` is still honored when it resolves; if it points at another
profile's row, Veyyon falls back to the profile-scoped url-keyed binding.

`/mcp reauth` on a definition-only entry leaves the file untouched, the
credential (refresh material included) lives entirely in the active profile's
auth storage (local `agent.db` or broker), so no config file ever picks up local
auth state. An explicitly configured `Authorization` header always wins over the
url-keyed binding.

The binding is per profile but not per project: once a profile has authorized a
URL, any config defining a server at that URL connects with that profile's
credential automatically. That is one reason a repository cannot define an MCP
server: a checked-in entry naming an already-authorized URL would have borrowed
the profile's credential. Servers you add through `/mcp add` are yours, and the
editor configs Veyyon still reads are named by file in `/mcp list`.

### `oauth`

```json
{
  "clientId": "...",
  "clientSecret": "...",
  "redirectUri": "...",
  "callbackPort": 3334,
  "callbackPath": "/oauth/callback",
  "prompt": "consent"
}
```

Use this when the MCP server requires explicit OAuth client settings.

`prompt` controls the OAuth `prompt` parameter sent with the authorization request. By default the parameter is omitted, matching the reference MCP SDK, except when the granted scopes include `offline_access`: OIDC Core requires `prompt=consent` to issue refresh-token access, so Veyyon sends `consent` for those requests. Without a consent prompt, a provider with an active browser session silently re-approves the same account, making it impossible to switch accounts or workspaces when reauthorizing (e.g. to use a different Linear workspace per Veyyon profile). Set it to `""` to omit the parameter for providers that reject it, or to another value the provider understands (e.g. `"select_account"`).

Slack is the clearest current example. Slack's MCP server is hosted at `https://mcp.slack.com/mcp`, uses Streamable HTTP, and requires confidential OAuth with your Slack app's client credentials.

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/santhreal/veyyon/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

Relevant Slack endpoints from Slack's docs:

- MCP endpoint: `https://mcp.slack.com/mcp`
- Authorization endpoint: `https://slack.com/oauth/v2_user/authorize`
- Token endpoint: `https://slack.com/api/oauth.v2.user.access`

## Common copy-paste examples

### Filesystem server via stdio

```json
{
  "$schema": "https://raw.githubusercontent.com/santhreal/veyyon/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/absolute/path/one",
        "/absolute/path/two"
      ]
    }
  }
}
```

### GitHub hosted server via HTTP

```json
{
  "$schema": "https://raw.githubusercontent.com/santhreal/veyyon/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/"
    }
  }
}
```

### GitHub local server via Docker

```json
{
  "$schema": "https://raw.githubusercontent.com/santhreal/veyyon/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "github": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
      }
    }
  }
}
```

This matches GitHub's official local Docker image `ghcr.io/github/github-mcp-server`.

### Slack hosted server via OAuth

```json
{
  "$schema": "https://raw.githubusercontent.com/santhreal/veyyon/main/packages/coding-agent/src/config/mcp-schema.json",
  "mcpServers": {
    "slack": {
      "type": "http",
      "url": "https://mcp.slack.com/mcp",
      "oauth": {
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      },
      "auth": {
        "type": "oauth",
        "tokenUrl": "https://slack.com/api/oauth.v2.user.access",
        "clientId": "YOUR_SLACK_CLIENT_ID",
        "clientSecret": "YOUR_SLACK_CLIENT_SECRET"
      }
    }
  }
}
```

## Secrets and variable resolution

This is the part that usually trips people up.

### Discovery-time `${...}` expansion

Veyyon expands `${VAR}` and `${VAR:-default}` placeholders while discovering MCP configs from Veyyon-native files and standalone fallback files. Expansion applies recursively to string values in `command`, `args`, `env`, `cwd`, `url`, `headers`, `auth`, and `oauth`; unresolved placeholders remain literal strings.

Example:

```json
{
  "mcpServers": {
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "headers": {
        "Authorization": "Bearer ${GITHUB_TOKEN}"
      }
    }
  }
}
```

### Pre-connect env/header resolution

Before Veyyon launches a stdio server or makes an HTTP/SSE request, it resolves stdio `env` values and HTTP/SSE `headers` values like this:

1. If a value starts with `!`, Veyyon runs the rest as a shell command with a 10s timeout and uses trimmed stdout.
2. If the command fails, times out, or prints only whitespace, that `env`/`headers` entry is omitted.
3. Otherwise Veyyon checks whether the value names an environment variable.
4. If that environment variable is set to a non-empty value, Veyyon uses the environment value; otherwise it uses the string literally.

Examples:

```json
{
  "env": {
    "GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"
  },
  "headers": {
    "X-MCP-Insiders": "true"
  }
}
```

That means this is valid and convenient for local secrets:

- `"GITHUB_PERSONAL_ACCESS_TOKEN": "GITHUB_PERSONAL_ACCESS_TOKEN"` → copy from the current shell environment
- `"Authorization": "Bearer hardcoded-token"` → use the literal value
- `"Authorization": "!printf 'Bearer %s' \"$GITHUB_TOKEN\""` → build the header from a command

## `disabledServers`

`disabledServers` is read from the user config file (`~/.veyyon/profiles/default/agent/mcp.json`) when a server is discovered from any source and you want Veyyon to ignore it without editing that other tool's config.

Example:

```json
{
  "$schema": "https://raw.githubusercontent.com/santhreal/veyyon/main/packages/coding-agent/src/config/mcp-schema.json",
  "disabledServers": ["github", "slack"]
}
```

## `/mcp add` vs editing JSON directly

Use `/mcp add` when you want guided setup.

Use direct JSON editing when:

- you need a transport or auth option the wizard does not prompt for yet
- you want to paste a server definition from another MCP client
- you want schema-backed validation in your editor

After editing, use:

- `/mcp reload` to rediscover and reconnect servers in the current session
- `/mcp list` to see which config file a server came from
- `/mcp test <name>` to test a single server
- `/mcp reconnect <name>` to reconnect one server without rediscovering all configs
- `/mcp resources`, `/mcp prompts`, and `/mcp notifications` to inspect non-tool MCP capabilities

## Validation rules Veyyon enforces

From `validateServerConfig()` in `packages/coding-agent/src/mcp/config.ts`:

- `stdio` requires `command`
- `http` and `sse` require `url`
- a server cannot set both `command` and `url`
- unknown `type` values are rejected

Practical implications:

- Omitting `type` means `stdio`
- If you paste a remote server config and forget `"type": "http"`, Veyyon will treat it as `stdio` and complain that `command` is missing
- `sse` remains valid for compatibility, but new hosted servers should usually be configured as `http`

## Discovery and precedence

Veyyon does not merge duplicate server definitions across files. Discovery providers are prioritized, and the higher-priority definition wins. Separately, `disabledServers` from `~/.veyyon/profiles/default/agent/mcp.json` can suppress a discovered server by name.

In practice:

- prefer `~/.veyyon/profiles/default/agent/mcp.json` when you want a Veyyon-specific override
- keep server names unique across tools when possible
- use `disabledServers` in the user config when a third-party config keeps reintroducing a server you do not want

## Troubleshooting

### `Server "name": stdio server requires "command" field`

You probably omitted `type: "http"` on a remote server.

### `Server "name": both "command" and "url" are set`

Pick one transport. Veyyon treats `command` as stdio and `url` as http/sse.

### `/mcp add` worked but the server still does not connect

The JSON is valid, but the server may still be unreachable. Use `/mcp test <name>` and check whether:

- the binary or Docker image exists
- required environment variables are set
- the remote URL is reachable
- the OAuth or API token is valid

### The server exists in another tool's config but not in Veyyon

Run `/mcp list`: it names the file each server came from. Veyyon discovers many third-party MCP files, but it never reads a repository's own `mcp.json`, `.mcp.json` or `.veyyon/mcp.json`, and a `disabledServers` entry in your profile's `mcp.json` can suppress a discovered server by name.

### A call fails with a protocol error rather than a timeout

JSON-RPC lets a server answer with `"id": null` when it cannot tell which request an error belongs
to. A parse error is the usual case: the server could not read the request well enough to find its
id, so it has nothing to attribute the failure to.

Veyyon surfaces that answer instead of waiting. Every call in flight on that connection fails with
the server's own code and message, for example:

```
MCP error -32700: Parse error
```

The alternative would be to ignore a reply that names no request, and then every pending call sits
until its timeout and reports that the server did not answer. That is the opposite of what
happened: the server answered, and told you exactly what was wrong.

A `-32700` means the bytes Veyyon sent were not valid JSON to that server, so report it with the
server name and the tool you called. It is a bug in the server or in the transport, not something a
config change fixes.

## References

- MCP transport spec: https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
- Filesystem server package: https://www.npmjs.com/package/@modelcontextprotocol/server-filesystem
- GitHub MCP server: https://github.com/github/github-mcp-server
- Slack MCP server docs: https://docs.slack.dev/ai/slack-mcp-server/
