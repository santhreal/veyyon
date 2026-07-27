# launch

> Launch and control long-running project processes shared by every veyyon instance in the same directory.

## Source
- Tool: `packages/coding-agent/src/tools/launch.ts`
- Broker client: `packages/coding-agent/src/launch/client.ts`
- Broker runtime: `packages/coding-agent/src/launch/broker.ts`
- Veyyon process presence: `packages/coding-agent/src/launch/presence.ts`
- Protocol: `packages/coding-agent/src/launch/protocol.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/launch.md`

## When to use it
Use `launch` for processes that stay alive after one tool call or need later interaction:
- web development servers and file watchers
- debuggers such as lldb and gdb
- REPLs and interactive application consoles
- local services whose logs or readiness must be observed

Use `bash` for commands that finish. Async bash remains appropriate for finite commands that need no later stdin; it is not a process supervisor.

## Operations

| Operation | Purpose | Main fields |
| --- | --- | --- |
| `start` | Launch a named process. | `name`, `application`, `args`, `env`, `cwd`, `pty`, `ready`, `restart`, `persist`, `detached` |
| `list` | Snapshot every managed process in the current project scope. | none |
| `logs` | Read, filter, or follow captured combined output. | `name`, `lines`, `head`, `grep`, `follow`, `cursor`, `timeout` |
| `wait` | Wait for readiness, exit, or an output regex. | `name`, `for`, `pattern`, `timeout` |
| `send` | Write stdin, terminal keys, or a process signal. | `name`, `text`, `enter`, `keys`, `signal` |
| `stop` | Gracefully terminate the managed process tree, then hard-kill if needed. | `name`, `timeout` |
| `restart` | Stop and relaunch using the retained launch specification. | `name` |
| `describe` | Show the retained launch specification and live state. | `name` |

Names are stable and unique within one project directory. A live name must be stopped or restarted; starting a completed name creates a new launch and rotates its prior output log.

## Starting and readiness
`application` and `args` are separate fields, so callers do not need shell quoting:

```json
{
  "op": "start",
  "name": "web",
  "application": "bun",
  "args": ["run", "dev"],
  "ready": {
    "log": "Local:.*http",
    "port": 5173,
    "timeout": 30
  }
}
```

Defaults:
- `cwd`: current coding-agent session directory
- `args`: `[]`
- `env`: `{}` over the broker's inherited environment
- `pty`: `true`
- `restart`: `no`
- `persist`: `false`
- `detached`: `false`
- readiness timeout: 30 seconds

`detached: true` implies `persist: true`, forces `pty: false`, and disables stdin. Its process survives broker shutdown and every veyyon exit; a later broker reconnects to its records for logs and explicit `stop`.

`ready.log` is a regular expression matched against captured output. `ready.port` probes TCP at `ready.host` (default `127.0.0.1`). When both are present, both must pass. A readiness timeout leaves the process running and returns its current state so the caller can inspect logs or stop it.

Without a readiness condition, a successfully created process enters `running`. With readiness configured, it moves `starting` → `ready`; launch or nonzero-exit failures move to `failed`.

## Logs and following
stdout and stderr are captured into one ordered stream when possible. PTY output is naturally combined.

```json
{"op":"logs","name":"web","lines":100}
{"op":"logs","name":"web","grep":"error|warn","lines":50}
{"op":"logs","name":"web","follow":true,"cursor":1842,"timeout":30}
```

Each logs result returns a byte cursor. `follow: true` waits until output advances beyond the supplied cursor, the process exits, or the timeout elapses, then returns a fresh window. `head: true` reads from the beginning; the default reads the tail.

The broker keeps a 25 MiB current log and one 25 MiB rotated log while it owns a process's output stream. A detached process writes directly to its disk log so it survives broker exit; output is not rotated while no broker is running.

## Input and signals

```json
{"op":"send","name":"debugger","text":"breakpoint set --name main"}
{"op":"send","name":"debugger","text":"run"}
{"op":"send","name":"debugger","keys":["CTRL_C"]}
```

`enter` defaults to true when `text` is present. Supported keys are `ENTER`, `TAB`, `ESCAPE`, `CTRL_C`, `CTRL_D`, `UP`, `DOWN`, `LEFT`, and `RIGHT`. Supported signals are `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, and `SIGKILL`.

All project clients may observe the same managed process. Input is one shared stream: each send operation is serialized, but two clients writing independently still address the same process stdin.

## Cross-instance lifecycle
Every veyyon session registers its process in the canonical project scope. The first `launch` call starts a detached broker over a private socket; later `launch` calls from any registered veyyon process connect to the same broker and see the same names, logs, and state.

Runtime data lives under `~/.veyyon/profiles/<profile>/run/daemons/<project-hash>/`:

| Path | What it holds |
| --- | --- |
| `broker.sock` | The broker's listening socket. On Windows there is no file here: the broker listens on the named pipe `\\.\pipe\veyyon-daemon-<project-hash>` instead. |
| `broker.token` | The shared secret, mode `0600`. The first client to need it creates it; the broker reads it at startup and rejects a request that does not present it. |
| `broker.pid` | The lease that elects one broker per project. A process claims the broker role by creating this file exclusively, and a stale file whose PID is dead is reclaimed by the next starter. |
| `clients/<pid>-<uuid>.json` | One entry per live veyyon process holding the project open. |
| `daemons/<name>/meta.json` | One managed process's persisted snapshot and spec, reread when a broker recovers. |
| `daemons/<name>/output.log` | That process's captured output. |
| `daemons/<name>/output.previous.log` | The log kept from before the last rotation. `logs` reads both files so a request spanning a rotation is still answered in order. |
| `daemons/<name>/process.pid` | That process's PID. Distinct from `broker.pid`, which is the broker's own lease. |

These names are a contract between separate processes, so they are declared in exactly one place in the source (`src/launch/paths.ts`) and every reader and writer asks it for a path. Renaming one is a break for any broker already running against the old layout.

After the last tool socket disconnects, the broker checks the project-presence records. Live veyyon PIDs keep non-persistent managed processes running even when those veyyon instances have not called `launch`; dead PIDs are removed. Once no veyyon process remains, the broker waits three seconds, stops every non-persistent managed process, and exits. This PID check still works when an veyyon process is killed without JavaScript cleanup.

`persist: true` explicitly opts a managed process out of last-client teardown. A broker with a live persistent process remains available without clients until another veyyon reconnects and stops it. Broker recovery terminates stale recorded children and preserves their records as exited instead of adopting an unknown process state.

## Restart policies
- `no`: never restart automatically (default)
- `on-failure`: restart after a nonzero exit or runtime failure
- `always`: restart after any unexpected exit

Automatic restarts use bounded exponential backoff up to 30 seconds. Explicit `stop` suppresses restart. `restart` always reuses the retained application, arguments, environment, working directory, PTY, readiness, persistence, and detached settings.

## Errors and limits
- Names must be 1-48 letters, numbers, dots, underscores, or hyphens.
- `ready.port` must be an integer from 1 through 65535.
- Invalid readiness, wait, or log regular expressions are rejected before use.
- Sending to a stopped managed process or to unavailable stdin is an error.
- `logs`, `wait`, and `stop` timeouts are capped at one hour by the tool.
- PTY process-group signaling is POSIX-native. Windows ConPTY accepts input and Ctrl-C; other POSIX signals become hard termination because Windows has no equivalent signal model.
