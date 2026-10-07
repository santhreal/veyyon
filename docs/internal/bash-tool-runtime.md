# Bash tool runtime

This document describes the **`bash` tool** runtime path used by agent tool calls, from command normalization to execution, truncation/artifacts, and rendering.

It also calls out where behavior diverges in interactive TUI, print mode, RPC mode, and user-initiated bang (`!`) shell execution.

## Scope and runtime surfaces

There are two different bash execution surfaces in coding-agent:

1. **Tool-call surface** (`toolName: "bash"`): used when the model calls the bash tool.
   - Entry point: `BashTool.execute()`.
   - Parameters include `command`, optional `env`, `timeout`, `cwd`, `pty`, `backgroundAfter`, and, when `async.enabled` is true, `async`.
2. **User bang-command surface** (`!cmd` from interactive input or RPC `bash` command): session-level helper path.
   - Entry point: `AgentSession.executeBash()`. A registered extension `user_bash` handler may return the result instead of running the command.

Both eventually use `executeBash()` in `src/exec/bash-executor.ts` for non-PTY execution, but only the tool-call path runs normalization/interception, optional managed background-job handling, and tool renderer logic.

Set `bash.enabled: false` in settings to remove the model-facing `bash` tool from the active tool registry. This does not disable user-initiated bang commands or RPC `bash` requests.

## End-to-end tool-call pipeline

## 1) Input handling and parameter merge

`BashTool.execute()` currently handles input before execution as follows:

- validates optional `env` names against shell-variable syntax (`Invalid bash env name: ...`),
- extracts a leading single-line `cd <path> && ...` into `cwd` when `cwd` was not supplied,
- rejects `async: true` when `async.enabled` is false.

There are no structured `head` or `tail` tool parameters in the current schema, and commands run mostly as written: aside from the leading `cd … &&` extraction into `cwd` and internal-URL expansion (`skill://`, `agent://`, `local:/`, …) applied to the command, every env value and an extracted `cwd`, there are no pre-execution rewrites. A mutating `gh` subcommand also drops the cached `issue://`/`pr://` rows it touches. Output limiting is handled by `OutputSink` truncation/artifacts.

## 2) Optional interception (blocked-command path)

If `bashInterceptor.enabled` is true, `BashTool` loads rules from settings (`getBashInterceptorRules()`) and runs `checkBashInterception()` against the command, checking both the original and the cwd-normalized form (after a leading `cd … &&` is extracted) when they differ.

Interception behavior:

- command is blocked **only** when the rule regex matches and either:
  - the rule's suggested tool is present in `ctx.toolNames`, or
  - the suggested tool is absent, `search` is present, and the rule has a `search` redirect (`grep`, `find`, `glob`, `ast_grep`); the message then names the matching `search` type.
- invalid regex rules are silently skipped.
- on block, `BashTool` throws `ToolError` with message:
  - `Blocked: ...`
  - original command included.

Default rule patterns (defined in code) target common misuses:

- file readers (`cat`, `head`, `tail`, ...)
- search tools (`grep`, `rg`, ...)
- file finders (`find`, `fd`, ...)
- in-place editors (`sed -i`, `perl -i`, `awk -i inplace`)
- shell redirection writes (`echo ... > file`, heredoc redirection)

### Caveat

`InterceptionResult` includes `suggestedTool`, but `BashTool` currently surfaces only the message text (no structured suggested-tool field in `details`).

## 3) CWD validation and timeout clamping

`cwd` is resolved relative to session cwd (`resolveToCwd`), then validated via `stat`:

- missing path -> `ToolError("Working directory does not exist: ...")`
- non-directory -> `ToolError("Working directory is not a directory: ...")`

`timeout: 0` disables the deadline. Any other value, or the 300-second default when omitted, is first capped by `tools.maxTimeout` when that setting is positive, then clamped to `[1, 3600]` seconds and converted to milliseconds. A clamped request adds a notice to the result.

Before anything spawns, `#admitSpawn()` applies the session's budget limits (`session.cpuLimitCores`, `session.cpuLimitKill` and the other session budget settings) and rejects the call while the session's budget group reports saturation.

## 4) Artifact allocation

Before execution, the tool allocates an artifact path/id (best-effort) for truncated output storage.

- artifact allocation failure is non-fatal: the session logs an error and execution continues without an artifact spill file,
- artifact id/path are passed into execution path for full-output persistence on truncation.

## 5) PTY vs non-PTY execution selection

PTY eligibility is decided by `canUseInteractiveBashPty(pty, ctx)` (`src/tools/shell/bash-pty-selection.ts`); the local PTY overlay runs only when all are true:

- tool input `pty === true`
- `VEYYON_NO_PTY !== "1"`
- tool context has UI (`ctx.hasUI === true` and `ctx.ui` set)

If `pty` is requested but unavailable, the call falls back to non-PTY and appends a `pty requested but unavailable …` notice.

`BashTool.execute()` dispatches in this order:

1. `async: true` starts a managed bash job and returns its job id.
2. When the session's client advertises a terminal capability (`clientBridge.capabilities.terminal` + `createTerminal`) and `pty` is false, the command runs on a **client-bridge editor terminal** (streaming `terminalId` updates, killing on timeout, mapping a signalled death to exit code `128 + signal`, throwing when the signal cannot be resolved to a number). The bridge takes precedence over auto-backgrounding.
3. A non-PTY call with an async job manager below its running-job cap runs as a **managed foreground job** (see "Live tool updates and async jobs").
4. Otherwise the call runs locally: the PTY overlay when eligible, else `executeBash()` directly. A call at the running-job cap takes this path.

That means print mode and non-UI RPC/tool contexts always use non-PTY.

## Non-interactive execution engine (`executeBash`)

## Shell session reuse model

`executeBash()` caches native `Shell` instances in a process-global map keyed by:

- shell path,
- configured command prefix,
- snapshot path,
- serialized shell env,
- optional agent session key,
- minimizer configuration.

Session-level bang-command executions pass `sessionKey: this.sessionId`.

Direct tool-call executions pass `sessionKey: this.session.getSessionId?.()`, when available. A managed bash job passes the per-job key `<sessionId>:async:<jobId>`, so each job gets its own shell session, plus `cpuSessionId: <sessionId>` so the job joins the session CPU budget. Without a session key, reuse falls back to shell config/snapshot/env.

Concurrent calls never share one `Shell`: the native session runs one command at a time and `Shell.abort()` kills every in-flight run on it. `executeBash()` tracks in-flight keys in `shellSessionsInUse`; while a key is busy, overlapping calls skip the cache and run on a one-shot `Shell` instance (same isolation as quarantined sessions). Only the owning call releases the in-use flag or deletes the cached session in its `finally`.

Cache eviction:

- a cancelled, timed-out or failed run drops its cached session; a cancelled or timed-out run also quarantines its key, so later calls on it run in one-shot shells until the interrupted run and its abort settle,
- a per-job `:async:` key drops its session when the job ends; a session with a live `nohup`/`&` child stays referenced until its last background job exits, polled every 5 seconds.

## Shell config and snapshot behavior

At each call, executor loads settings shell config (`shell`, `env`, optional `prefix`). An interactive `!` command passes `useUserShell: true`: when no `shellPath` is configured, the platform is not Windows, and `$SHELL` names a supported executable shell other than the configured one, the command runs in `$SHELL`. A non-bash user shell receives the command as `<shell> <args…> -i <command>` (interactive flags added).

If selected shell includes `bash`, it attempts `getOrCreateSnapshot()`:

- snapshot captures aliases/functions/options from user rc,
- snapshot creation is best-effort,
- failure falls back to no snapshot.

If `prefix` is configured, command becomes:

```text
<prefix> <command>
```

The per-command child environment is built by `buildNonInteractiveEnv()` (`src/exec/non-interactive-env.ts`), which layers non-interactive hardening defaults **under** the caller's `env` overrides:

- pagers disabled (`PAGER=cat`, `GIT_PAGER=cat`, … and `LESS=FRX`),
- editor prompts disabled (`GIT_EDITOR=true`, `EDITOR=true`, `VISUAL=true`),
- terminal/credential prompts reduced (`TERM=dumb`, `GIT_TERMINAL_PROMPT=0`, `SSH_ASKPASS=/usr/bin/false`, `NO_COLOR=1`, `CI=1`),
- package-manager/tooling automation flags for non-interactive behavior (npm/pnpm/yarn/pip/cargo/terraform/gh, …),
- on Windows, UTF-8 locale/codepage defaults are added when absent.

## Streaming and cancellation

`Shell.run()` streams chunks to `OutputSink` and optional `onChunk` callback.

Cancellation:

- aborted signal triggers `shellSession.abort(...)`,
- timeout from native result is mapped to `cancelled: true` + annotation text,
- explicit cancellation similarly returns `cancelled: true` + annotation.

No exception is thrown inside executor for timeout/cancel; it returns structured `BashResult` and lets caller map error semantics.

## Interactive PTY path (`runInteractiveBashPty`)

When PTY is enabled, tool runs `runInteractiveBashPty()` which opens an overlay console component and drives a native `PtySession`.

Behavior highlights:

- xterm-headless virtual terminal renders viewport in overlay,
- keyboard input is normalized (including Kitty sequences and application cursor mode handling),
- `esc` while running kills the PTY session,
- terminal resize propagates to PTY (`session.resize(cols, rows)`).

Unlike the non-PTY engine, the interactive PTY path does **not** apply the non-interactive hardening. It inherits the user's environment and sets a real `TERM=xterm-256color` (applied as an override on the Rust side) so editors, pagers, and TUIs behave like a normal terminal.

PTY output is normalized (`CRLF`/`CR` to `LF`, `sanitizeText`) and written into `OutputSink`, including artifact spill support.

On PTY startup/runtime error, sink receives `PTY error: ...` line and command finalizes with undefined exit code.

## Output handling: streaming, truncation, artifact spill

Both PTY and non-PTY paths use `OutputSink`.

## OutputSink semantics

The bash executor builds the sink with `headBytes` and `maxColumns` from settings (`resolveOutputSinkHeadBytes` / `resolveOutputMaxColumns`).

- keeps a UTF-8-safe rolling **tail** window (`spillThreshold`) and, on overflow, trims to the tail (UTF-8 boundary safe) and marks `truncated`. The tool path passes `inlineBudgetFor(session)`: `tools.artifactSpillThreshold` (50KB by default) scaled down as the session's turn index grows, never below the `tools.inlineOutputFloor` fraction. The bang-command path uses the sink default,
- when `headBytes > 0` (`tools.artifactHeadBytes`, default 20KB) it also retains a **head** window and elides the middle, splicing an elision marker between head and tail in `dump()`,
- per-line column cap: when `maxColumns > 0` (`tools.outputMaxColumns`, default 768 bytes) over-wide lines are ellipsis-truncated at write time and the rest of the line is dropped,
- tracks total bytes/lines seen,
- mirrors the **raw, uncapped** stream to the artifact file when output overflows, a column cap dropped bytes, or the file is already active,
- marks `truncated` on tail overflow, middle elision, column-cap drops, or file spill.

`dump()` returns:

- `output` (possibly annotated prefix),
- `truncated`,
- `totalLines/totalBytes`,
- `outputLines/outputBytes`,
- `elidedBytes/elidedLines` when the middle was elided,
- `columnDroppedBytes/columnTruncatedLines` when the per-line cap fired,
- `artifactId` if artifact file was active.

### Long-output caveat

Runtime truncation is byte-threshold based in `OutputSink` (50KB tail window by default, plus an optional head window for middle elision). It does not enforce a hard line-count cap in this code path.

### Shell output minimizer

Non-PTY execution also passes shell-minimizer settings into the native `Shell` session. When the minimizer rewrites verbose output, the executor replaces the sink's visible text with the minimized text and, when possible, saves the raw original capture as a separate `bash-original` artifact referenced by a `[raw output: artifact://<id>]` footer.

## Live tool updates and async jobs

For non-PTY execution, `BashTool` uses a separate `TailBuffer` for partial updates and emits `onUpdate` snapshots while the command is running.

For PTY execution, live rendering is handled by custom UI overlay, not by `onUpdate` text chunks.

When `async.enabled` is true and the call passes `async: true`, `BashTool` starts a managed bash job, returns a running job result with a job id, and stores completion through the session managed-job path.

A managed foreground call registers the same managed job, suppresses its completion delivery, and waits for the first of:

- completion, returned as the tool result,
- failure, thrown as the tool error,
- the abort signal, which cancels the job and throws `ToolAbortError`,
- the wall-clock threshold (`bash.autoBackground.thresholdMs`, default 300000 ms, when `bash.autoBackground.enabled` is true), or the call's own `backgroundAfter` seconds, which overrides the setting and applies when it is off; `0` backgrounds at once,
- the stall window (`bash.stallDetection.stallMs`, when `bash.stallDetection.enabled` is true) with no new output,
- the operator's background key (`ctrl+b`).

The last three return a running job result with `details.async.reason` set to `threshold`, `stall` or `manual`, and resume completion delivery for the job. Each timer is capped at the command's timeout minus one second and is off when that cap reaches `0`.

## Result shaping, metadata, and error mapping

After execution:

1. `cancelled` handling:
   - if abort signal is aborted -> throw `ToolAbortError` (abort semantics),
   - else -> throw `ToolError` (treated as tool failure).
2. PTY `timedOut` -> throw `ToolError`.
3. empty output becomes `(no output)`.
4. append the call's notices (timeout clamp, unavailable PTY, unresolved skill scope, a CPU-budget kill report on SIGTERM) and, on a non-zero exit, the `formatExitCodeNotice()` line (`Command exited with code N`, or `Command was killed by SIGNAME (n); the shell reports this as exit code N` for a signalled death),
5. cap the text at the inline budget with `enforceInlineByteCap()`, saving the full text as a `bash-original` artifact with a `[raw output: artifact://<id>]` footer when bytes were elided,
6. attach truncation metadata via `toolResult(...).truncationFromSummary(result, { direction: "tail" })`.
7. exit-code mapping:
   - missing exit code -> throw `ToolError("... missing exit status")`
   - non-zero exit -> error result with `details.exitCode` (and `details.signal` for a signalled death)
   - zero exit -> success result.

Success payload structure:

- `content`: text output,
- `details.timeoutSeconds` (or `details.timeoutDisabled`), `details.requestedTimeoutSeconds` when clamped, `details.wallTimeMs`, and `details.terminalId` on the bridge path,
- `details.meta.truncation` when truncated, including:
  - `direction`, `truncatedBy`, total/output line+byte counts,
  - `shownRange`,
  - `artifactId` when available.

Because built-in tools are wrapped with `wrapToolWithMetaNotice()`, truncation notice text is appended to final text content automatically (for example: `Read artifact://<id> for full output`).

## Rendering paths

## Tool-call renderer (`bashToolView`)

`bashToolView` (`src/tools/shell/bash-view.ts`) is a host-agnostic `ToolViewRenderer` for tool-call messages (`toolCall` / `toolResult`). It strips the exit-code, wall-time, background and raw-output-artifact notices from the result text and states them as their own facts:

- the call section shows the command and its env assignments, including assignments decoded from a still-streaming `__partialJson`,
- collapsed mode condenses each progress run (for example a `Compiling …` wall) into its newest line plus a count and requests a `tail` window of `DEFAULT_TERMINAL_PREVIEW_LINES` rows; output carrying a SIXEL image is never windowed,
- expanded mode shows every line of the result text,
- a stats row shows `Backgrounded: <jobId>`, `Wall: <s>s`, `Timeout: <s>s` (with `(requested Ns clamped)` when clamped, or `Timeout: disabled`), `Artifact: <id>`, and `Exit: N (SIGNAME)` for a failed exit,
- a warning row shows `formatTruncationMetaNotice()` text when `details.meta.truncation` is present.

### Caveat: full artifact expansion

Expanded view shows the text already in the result content (tail/truncated output). Spilled bytes are read through `artifact://<id>`; the renderer does not load them.

## User bang-command component (`BashExecutionComponent`)

`BashExecutionComponent` is for user `!` commands in interactive mode (not model tool calls):

- streams chunks live,
- collapsed preview keeps last 20 logical lines,
- line clamp at 4000 display columns per line, with a `[N visible columns omitted]` note,
- shows truncation + artifact warnings when metadata is present,
- marks cancelled/error/exit state separately.

This component is wired by `CommandController.handleBashCommand()` and fed from `AgentSession.executeBash()`.

## Mode-specific behavior differences

| Surface                        | Entry path                                            | PTY eligible                                          | Live output UX                                                           | Error surfacing                                  |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------ |
| Interactive tool call          | `BashTool.execute`                                    | Yes, when `pty=true` and UI exists and `VEYYON_NO_PTY!=1` | PTY overlay (interactive) or streamed tail updates                       | Tool errors become `toolResult.isError`          |
| Print mode tool call           | `BashTool.execute`                                    | No (no UI context)                                    | No TUI overlay; output appears in event stream/final assistant text flow | Same tool error mapping                          |
| RPC tool call (agent tooling)  | `BashTool.execute`                                    | Usually no UI -> non-PTY                              | Structured tool events/results                                           | Same tool error mapping                          |
| Interactive bang command (`!`) | `AgentSession.executeBash` + `BashExecutionComponent` | No (uses executor directly)                           | Dedicated bash execution component                                       | Controller catches exceptions and shows UI error |
| RPC `bash` command             | `rpc-commands` -> `session.executeBash`               | No                                                    | Returns `BashResult` directly                                            | Consumer handles returned fields                 |

## Operational caveats

- Interceptor only blocks commands when the suggested tool, or `search` for a rule with a `search` redirect, is currently available in context.
- If artifact allocation fails, truncation still occurs but no `artifact://` back-reference is available.
- The shell session cache is process-scoped; entries are dropped only on reset (cancel, timeout, error) or at the end of a per-job `:async:` key.
- PTY and non-PTY timeout surfaces differ:
  - PTY exposes explicit `timedOut` result field,
  - non-PTY maps timeout into `cancelled + annotation` summary.

## Implementation files

- [`src/tools/shell/bash.ts`](../../packages/coding-agent/src/tools/shell/bash.ts): tool entrypoint, input handling/interception, async and PTY/non-PTY selection, and result/error mapping.
- [`src/tools/shell/bash-view.ts`](../../packages/coding-agent/src/tools/shell/bash-view.ts): `BashViewArgs`, `BashViewResult`, and the `bashToolView` renderer that describes the call row and the result card for any host.
- [`src/tools/shell/bash-pty-selection.ts`](../../packages/coding-agent/src/tools/shell/bash-pty-selection.ts): `canUseInteractiveBashPty` predicate for choosing the local PTY overlay.
- [`src/tools/shell/bash-interceptor.ts`](../../packages/coding-agent/src/tools/shell/bash-interceptor.ts): interceptor rule matching and blocked-command messages.
- [`src/exec/bash-executor.ts`](../../packages/coding-agent/src/exec/bash-executor.ts): non-PTY executor, shell session reuse, cancellation wiring, output sink integration.
- [`src/exec/non-interactive-env.ts`](../../packages/coding-agent/src/exec/non-interactive-env.ts): non-interactive child-process env defaults (`buildNonInteractiveEnv`) used by the non-PTY executor.
- [`src/tools/shell/bash-interactive.ts`](../../packages/coding-agent/src/tools/shell/bash-interactive.ts): PTY runtime, overlay UI, input normalization, and interactive `TERM` setup.
- [`src/session/streaming-output.ts`](../../packages/coding-agent/src/session/streaming-output.ts): `OutputSink`, `TailBuffer`, truncation/artifact spill, and summary metadata.
- [`src/tools/core/output-meta.ts`](../../packages/coding-agent/src/tools/core/output-meta.ts): truncation metadata shape + notice injection wrapper.
- [`src/session/agent-session.ts`](../../packages/coding-agent/src/session/agent-session.ts): session-level `executeBash`, message recording, abort lifecycle.
- [`src/modes/terminal/components/transcript/bash-execution.ts`](../../packages/coding-agent/src/modes/terminal/components/transcript/bash-execution.ts): interactive `!` command execution component.
- [`src/modes/terminal/controllers/command-controller.ts`](../../packages/coding-agent/src/modes/terminal/controllers/command-controller.ts): wiring for interactive `!` command UI stream/update completion.
- [`src/modes/rpc/rpc-commands.ts`](../../packages/coding-agent/src/modes/rpc/rpc-commands.ts): RPC `bash` and `abort_bash` command surface.
- [`src/internal-urls/artifact-protocol.ts`](../../packages/coding-agent/src/internal-urls/artifact-protocol.ts): `artifact://<id>` resolution.

*Verified against `deea84f9a0` on 2026-10-06.*
