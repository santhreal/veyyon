# MCP runtime lifecycle

This document describes how MCP servers are discovered, connected, exposed as tools, refreshed, and torn down in the coding-agent runtime.

## Lifecycle at a glance

1. **SDK startup** kicks off MCP discovery (unless MCP is disabled): headless/SDK sessions await `discoverAndLoadMCPTools()`; interactive sessions (`hasUI: true`) create the manager up front and defer `discoverAndConnect()` until the session is live.
2. **Discovery** (`loadAllMCPConfigs`) resolves MCP server configs from capability sources, drops denylisted and disabled entries, filters Exa entries and browser MCP servers when the built-in browser tool is enabled, and preserves source metadata.
3. **Manager connect phase** (`MCPManager.connectServers`) starts per-server connect + `tools/list` in parallel.
4. **Fast startup gate** waits up to 250ms, then may return:
   - fully loaded `MCPTool`s,
   - failures per server,
   - or cached `DeferredMCPTool`s for still-pending servers.
5. **SDK wiring** merges MCP tools into runtime tool registry for the session.
6. **Post-connect enrichment** best-effort loads resources, resource templates, prompts, and optional resource subscriptions.
7. **Live session** can refresh MCP tools via `/mcp` flows (`disconnectAll` + rediscover + `session.refreshMCPTools`) and can reconnect individual servers on transport close or `/mcp reconnect`.
8. **Teardown** happens when callers invoke `disconnectServer`/`disconnectAll`; manager also clears MCP tool/resource/prompt registrations for disconnected servers.

## Discovery and load phase

### Entry path from SDK

`createAgentSession()` in `src/sdk.ts` performs MCP startup when `enableMCP` is true (default). There are two paths:

- **Headless/SDK** (no UI, no provided manager): awaits `discoverAndLoadMCPTools(cwd, { ... })` and merges the returned tools into the startup `customTools` set.
- **Interactive/TUI** (`hasUI: true`, no provided manager): constructs `MCPManager` immediately (with cache + auth storage), defers `discoverAndConnect()` to a background task started after the session exists, then binds tools via `session.refreshMCPTools(...)` (disposing the manager if the session was torn down mid-connect).

Both paths:

- share one discover options object: `onStatus`, `filterExa: true`, `filterBrowser` from the `browser.enabled` setting, and `agentDir` (the session's own profile, so its MCP servers come from the same profile as its rules and commands),
- give the manager auth storage and a tool cache, by different routes: the headless path passes `authStorage` and `cacheStorage` as loader options, the interactive path constructs `MCPManager` with the cache and calls `setAuthStorage`,
- log per-server load/connect errors,
- store the manager in `toolSession.mcpManager` and the session result.

If `enableMCP` is false, MCP discovery is skipped entirely.

### Config discovery and filtering

`loadAllMCPConfigs()` (`src/mcp/config.ts`) loads canonical MCP server items through capability discovery, then converts to legacy `MCPServerConfig`.

Filtering behavior:

- There is no project-level filter. The `enableProjectConfig` option and its `mcp.enableProjectConfig` settings row are gone, together with the project config files they gated: no provider reads a repository's `.mcp.json`, `mcp.json`, or `.veyyon/mcp.json`, because a repository must not name a server the agent connects to. The native provider reads `<agentDir>/mcp.json` and `<agentDir>/.mcp.json` only, and each foreign provider (claude, codex, cursor, gemini, opencode, windsurf) reads its own home config only. A server whose `_source.level` is `project` is reachable two ways, and both only because it was explicitly installed: `getEnabledPlugins` enumerates `<projectAnchor>/.veyyon/plugins` for a plugin installed with `--scope project`, and the `veyyon-plugins` provider loads that package's own `.mcp.json` or `mcp.json` at the root's level; the `claude-plugins` provider does the same, reading `.mcp.json` from a marketplace plugin whose entry in the nearest `.veyyon/plugins/installed_plugins.json` is project-scoped.
- Servers named in the user config's `disabledServers` list are dropped, and `enabled: false` servers are skipped before connect attempts unless the same file's `enabledServers` list force-enables them.
- Exa servers are filtered out by default and API keys are extracted for native Exa tool integration; browser automation MCP servers are filtered when `filterBrowser` is true.

Result carries `configs`, `sources` (metadata used later for provider labeling), `exaApiKeys`, and `warnings` (config files that were present but unreadable, so a server that never got a name still has something to report a failure against).

### Discovery-level failure behavior

`discoverAndLoadMCPTools()` distinguishes two failure classes, and `discoverAndConnect()` surfaces a third:

- **Discovery hard failure** (exception from `manager.discoverAndConnect`, typically from config discovery): returns an empty tool set and one synthetic error `{ path: ".mcp.json", error }`.
- **Per-server runtime/connect failure**: manager returns partial success with `errors` map; other servers continue.
- **Config-file warning** (a file that is present but does not parse, an entry with neither `command` nor `url`): `discoverAndConnect` reports each one through `onStatus` as a failure under the pseudo-server label `MCP_CONFIG_STATUS_LABEL` (`"mcp config"`), emitted after `connectServers` returns so its `connecting` event cannot wipe it. Every other server still loads.

So startup does not fail the whole agent session when individual MCP servers fail.

## Manager state model

`MCPManager` tracks runtime lifecycle with separate registries:

- `#connections: Map<string, MCPServerConnection>`: fully connected servers.
- `#pendingConnections: Map<string, Promise<MCPServerConnection>>`: handshake in progress.
- `#pendingToolLoads: Map<string, Promise<{ connection, serverTools }>>`: connected but tools still loading.
- `#tools: CustomTool[]`: current MCP tool view exposed to callers.
- `#sources: Map<string, SourceMeta>`: provider/source metadata even before connect completes.
- `#pendingReconnections: Map<string, Promise<MCPServerConnection | null>>`: reconnects in progress after a dropped transport or explicit reconnect.
- `#serverConfigs: Map<string, MCPServerConfig>`: original unresolved configs preserved so reconnect can re-resolve credentials without leaking resolved tokens.
- `#lastErrors: Map<string, string>`: last connection failure per server, cleared when it connects, read back by `getLastError` so `/mcp list` can say why a server is not connected.

`getConnectionStatus(name)` derives status from these maps:

- `connected` if in `#connections`,
- `connecting` if pending connect, pending tool load, or pending reconnect,
- `disconnected` otherwise.

## Connection establishment and startup timing

## Per-server connect pipeline

For each discovered server in `connectServers()`:

1. store/update source metadata,
2. skip if already connected/pending/reconnecting,
3. validate transport fields (`validateServerConfig`),
4. resolve auth/shell substitutions (`#resolveAuthConfig`),
5. call `connectToServer(name, resolvedConfig)` with manager notification/request handlers,
6. wire HTTP OAuth refresh and transport `onClose` reconnect handling,
7. call `listTools(connection)`,
8. cache tool definitions (`MCPToolCache.set`) best-effort,
9. best-effort load resources, resource templates, prompts, and subscriptions after tools load.

`connectToServer()` behavior (`src/mcp/client.ts`):

- creates a stdio, Streamable HTTP, or legacy HTTP+SSE transport (`type` defaults to `stdio`; any other value is rejected),
- performs MCP `initialize`,
- for the Streamable HTTP transport, calls its `startSSEListener()` between the `initialize` response and `notifications/initialized`, so server-to-client requests that the notification triggers can be delivered; the legacy SSE transport already opened its stream during `connect()`,
- sends `notifications/initialized`,
- uses the timeout `resolveMCPTimeoutMs` returns: `VEYYON_MCP_TIMEOUT_MS` when it parses as a non-negative number, else `config.timeout`, else 30s; `0` disables the client-side timeout,
- closes transport on init failure.

### Fast startup gate + deferred fallback

`connectServers()` waits on a race between:

- all connect/tool-load tasks settled, and
- `STARTUP_TOOL_WAIT_MS = 250` (a grace window, not a timeout: unsettled connects keep running in the background).

After 250ms:

- fulfilled tasks become live `MCPTool`s,
- rejected tasks produce per-server errors,
- still-pending tasks:
  - use cached tool definitions if available (`MCPToolCache.get`) to create `DeferredMCPTool`s,
  - otherwise contribute no tools at startup; they stay in flight, and the background continuation registers their tools via `#onToolsChanged` once connect/list finishes (a slow server no longer blocks startup: issue #2100).

This is a hybrid startup model: fast return with deferred handles when cache is available, late background registration when it is not.

### Background completion behavior

Each pending `toolsPromise` also has a background continuation that eventually:

- replaces that server’s tool slice in manager state via `#replaceServerTools`,
- writes cache,
- logs late failures only after startup (`allowBackgroundLogging`).

## Tool exposure and live-session availability

### Startup registration

`discoverAndLoadMCPTools()` converts manager tools into `LoadedCustomTool[]` and decorates paths (`mcp:<server> via <providerName>` when known).

`createAgentSession()` then pushes these tools into `customTools`, which are wrapped and added to the runtime tool registry with names like `mcp__<server>_<tool>`.

### Tool calls

- `MCPTool` calls tools through an already connected `MCPServerConnection`.
- `DeferredMCPTool` waits for `waitForConnection(server)` before calling; this allows cached tools to exist before connection is ready.
- Both attempt a reconnect + single retry for retriable connection failures.

Both return structured tool output and convert remaining transport/tool errors into a result reading `MCP tool "<tool>" on server "<server>" failed: <detail>`, followed by a fixed next-step line that caps the model's retries at one (abort remains abort). A detail that echoes the call's own arguments back is withheld and replaced with a note saying so, so a credential passed as an argument cannot land in the transcript.

## Refresh/reload paths (startup vs live reload)

### Initial startup path

- one-time discovery/load in `sdk.ts`,
- tools are registered in initial session tool registry.

### Interactive reload path

`/mcp reload` path (`src/modes/controllers/mcp-command-controller.ts`) does:

1. `mcpManager.disconnectAll()`,
2. `mcpManager.discoverAndConnect()`,
3. `session.refreshMCPTools(mcpManager.getTools())`.

`session.refreshMCPTools()` (`src/session/agent-session.ts`) removes all `mcp__` tools, re-wraps latest MCP tools, and re-activates tool set so MCP changes apply without restarting session.

There is also a follow-up path for late connections: after waiting for a specific server, if status becomes `connected`, it re-runs `session.refreshMCPTools(...)` so newly available tools are rebound in-session.

## Health, reconnect, and partial failure behavior

Current runtime behavior is connection-event driven:

- **No autonomous polling health monitor** in manager/client.
- **Automatic reconnect is wired to `transport.onClose`** for managed connections.
- Reconnect retries with backoff (`500`, `1000`, `2000`, `4000` ms), reloads tools, and notifies consumers on success. A crash-storm circuit breaker suspends automatic reconnects for a server after more than 5 reconnect attempts within 30s; manual `/mcp reconnect` resets that history.
- Tool calls that see retriable connection errors also attempt one reconnect + retry.
- Reconnect is also explicit via `/mcp reconnect <name>` or broader `/mcp reload`.

Operationally:

- one server failing does not remove tools from healthy servers,
- connect/list failures are isolated per server,
- stale tools may remain visible while reconnect is attempted; calls return the MCP tool-failure result if recovery fails,
- tool cache, resource/prompt loading, subscriptions, and background updates are best-effort (warnings/errors logged, no hard stop).

## Teardown semantics

### Server-level teardown

`disconnectServer(name)`:

- removes pending entries, source metadata, saved config, resource refresh/subscription state,
- detaches `onClose` so explicit close does not trigger reconnect,
- closes transport if connected,
- removes manager tool entries using the sanitized `mcpToolNamePrefix(name)` filter from `tool-bridge.ts` (so servers whose names needed sanitizing are filtered correctly); the raw-name `mcp__${name}_` string remains only in the `hadTools` notification check.

### Global teardown

`disconnectAll()`:

- detaches `onClose` for all active transports, then closes them with `Promise.allSettled`,
- clears pending maps, sources, saved configs, connections, subscriptions, resource refreshes, and manager tool list.

In current wiring, explicit teardown is used in MCP command flows (for reload/remove/disable). Startup stores the manager on the session; callers that need deterministic MCP shutdown should invoke manager disconnect methods.

## Failure modes and guarantees

| Scenario                                             | Behavior                                                                                                                  | Hard fail vs best-effort       |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Discovery throws (capability/config load path)       | Loader returns empty tools + synthetic `.mcp.json` error                                                                  | Best-effort session startup    |
| Invalid server config                                | Server skipped with validation error entry                                                                                | Best-effort per server         |
| Connect timeout/init failure                         | Server error recorded; others continue                                                                                    | Best-effort per server         |
| `tools/list` still pending at startup with cache hit | Deferred tools returned immediately                                                                                       | Best-effort fast startup       |
| `tools/list` still pending at startup without cache  | No tools at startup; background continuation registers them via `#onToolsChanged` when ready                              | Best-effort late registration  |
| Late background tool-load failure                    | Logged after startup gate                                                                                                 | Best-effort logging            |
| Runtime dropped transport                            | Manager attempts reconnect; stale tools remain while reconnecting and future calls may retry once or return the tool-failure result | Best-effort automatic recovery |

## Public API surface

`src/mcp/index.ts` re-exports loader/manager/client APIs for external callers. `src/sdk.ts` exposes `discoverMCPServers()` as a convenience wrapper returning the same loader result shape.

## Implementation files

- [`src/mcp/loader.ts`](../../packages/coding-agent/src/mcp/loader.ts): loader facade, discovery error normalization, `LoadedCustomTool` conversion.
- [`src/mcp/manager.ts`](../../packages/coding-agent/src/mcp/manager.ts): lifecycle state registries, parallel connect/list flow, refresh/disconnect.
- [`src/mcp/client.ts`](../../packages/coding-agent/src/mcp/client.ts): transport setup, initialize handshake, list/call/disconnect.
- [`src/mcp/index.ts`](../../packages/coding-agent/src/mcp/index.ts): MCP module API exports.
- [`src/sdk.ts`](../../packages/coding-agent/src/sdk.ts): startup wiring into session/tool registry.
- [`src/mcp/config.ts`](../../packages/coding-agent/src/mcp/config.ts): config discovery/filtering/validation used by manager.
- [`src/mcp/tool-bridge.ts`](../../packages/coding-agent/src/mcp/tool-bridge.ts): `MCPTool` and `DeferredMCPTool` runtime behavior.
- [`src/session/agent-session.ts`](../../packages/coding-agent/src/session/agent-session.ts): `refreshMCPTools` live rebinding.
- [`src/modes/controllers/mcp-command-controller.ts`](../../packages/coding-agent/src/modes/controllers/mcp-command-controller.ts): interactive reload/reconnect flows.
- [`src/task/executor.ts`](../../packages/coding-agent/src/task/executor.ts): subagent MCP proxying via parent manager connections.

*Verified against `19234e94d39e` on 2026-08-07.*
