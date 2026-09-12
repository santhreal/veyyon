# The ACP server

`veyyon acp` runs Veyyon as an Agent Client Protocol server: JSON-RPC over stdio, spoken by an
editor or client that spawns the process. stdout is the transport, so nothing else is printed
there; logs go to `~/.veyyon/profiles/<name>/logs/`.

```bash
veyyon acp
veyyon acp --model anthropic/claude-sonnet-4-5
veyyon acp --approval-mode yolo
veyyon acp --config ./acp.yml
```

`acp` takes every launch flag (`veyyon --help` lists them) and forces `--mode acp`. Run by hand
with a terminal on stdin, it prints a notice on stderr and waits for protocol frames.

Implementation: `packages/coding-agent/src/modes/acp/`. The RPC surface in
[The RPC surface](./rpc.md) is a separate protocol; a client uses one or the other.

## Client configuration

Zed:

```json
{
  "agent_servers": {
    "Veyyon": { "command": "veyyon", "args": ["acp"] }
  }
}
```

## Capabilities

`initialize` advertises:

| Capability | Value |
| --- | --- |
| `loadSession` | `true` |
| `mcpCapabilities` | `http`, `sse` |
| `promptCapabilities` | `embeddedContext`, `image` |
| `sessionCapabilities` | `list`, `fork`, `resume`, `close` |

Auth methods:

| Method id | When offered | Effect |
| --- | --- | --- |
| `agent` | always | Use the provider keys and OAuth state already configured under the active profile. |
| `terminal` | the client reports `auth.terminal` | Re-run the same command with `--acp-terminal-auth`, which opens the interactive TUI to add keys and pick models instead of serving ACP. |

`authenticate` with any other `methodId` fails.

## Sessions

`session/new`, `session/load`, `session/resume` and `session/fork` require an absolute `cwd`;
a relative one fails. Each accepts `mcpServers` for the session. `session/list` pages 50 per
page. `session/close` releases the session.

The session's MCP servers, approval mode and settings come from the active profile's
`config.yml`, plus any `--config` overlay passed to the server process; see
[Approval modes](./approval-mode.md#acp-sessions).

### Modes

| Mode id | Present when | Behaviour |
| --- | --- | --- |
| `default` | always | Headless run. |
| `plan` | `plan.enabled` is true | Read-only planning that writes a Markdown plan before any code change; the plan is returned with the options `Approve and execute` and `Refine plan`. |

`session/set_mode` with any other id fails, and a change is echoed as a `current_mode_update`.

### Config options

`session/set_config_option` accepts three string-valued options; a boolean value fails.

| `configId` | Value |
| --- | --- |
| `mode` | A mode id from the table above. |
| `model` | `provider/model`, chosen from the models the session lists. |
| `thinking` | A thinking level the current model accepts, or `off`. |

The response and a `config_option_update` carry the resolved option set.

### Prompting

`session/prompt` accepts text, embedded context and image blocks. A prompt that begins with a
slash runs the matching slash or skill command and streams the command's output as agent text.
A prompt sent while a turn is still streaming cancels that turn first, then runs. `session/cancel`
aborts the running turn; the prompt response reports `cancelled`.

Tool calls that require approval go to the client through `session/request_permission`. A client
that reports `fs.readTextFile`, `fs.writeTextFile` or `terminal` capabilities has those calls
routed through it; otherwise Veyyon reads, writes and runs locally.

## Extension methods

Custom methods are prefixed `_veyyon/`; the older `_omp/` prefix is accepted and mapped.

| Method | Params | Returns |
| --- | --- | --- |
| `_veyyon/sessions/listAll` | `limit` (1–5000, default 1000) | Every stored session, newest first, plus `total`. |
| `_veyyon/projects/list` | | Sessions grouped by `cwd` with counts and last activity. |
| `_veyyon/chats/byCwd` | `cwd` (required), `limit` (1–500, default 100) | Sessions for one directory. |
| `_veyyon/usage` | | Provider usage reports for the active session. |
| `_veyyon/extensions` | `cwd` | The loaded extensions, minus `disabledExtensions`. |
| `_veyyon/extensions/toggle` | `providerId`, `enabled` | Enables or disables a discovery provider for this process. |
| `speech.models.list` | | The on-device speech model catalog. |

An unknown method fails with `Unknown ACP ext method`.

## Exit

The process exits `0` when the client closes the connection. Other codes follow
[Exit codes](./exit-codes.md).
