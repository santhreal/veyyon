Runs commands in the embedded shell — terminal ops: git, bun, cargo, python.

# When to use bash — and when not to

The shell invokes **real binaries** with simple args. It is NOT full GNU Bash.

Use bash ONLY for: a single binary call, or one short pipeline that COMPUTES a fact and does not depend on shell-specific regex/quoting (`wc -l`, `sort | uniq -c`, `comm`, `diff`, a checksum, `git status`).

{{#if hasEval}}Anything below → `eval` cell, not bash:
- Inline interpreter scripts (`-e`/`-c`/`--eval`) when an eval runtime exists for that language
- Heredocs (`<<EOF`), `while`/`for`/`if`/`case` shell control flow
- `$(…)` command substitution nested inside another command
- Pipelines with more than two stages, or stages that need control flow or quote/JSON escaping
- Multiline commands, `&&`-chains mixing control flow
- Quote/JSON escaping that fights the shell
{{else}}Anything below means you are writing a shell program, not invoking one. Prefer a purpose-built tool, a checked-in script, or a single repo command instead:
- Inline interpreter scripts (`-e`/`-c`/`--eval`)
- Heredocs (`<<EOF`), `while`/`for`/`if`/`case` shell control flow
- `$(…)` command substitution nested inside another command
- Pipelines with more than two stages, or stages that need control flow or quote/JSON escaping
- Multiline commands, `&&`-chains mixing control flow
- Quote/JSON escaping that fights the shell
{{/if}}
{{#if hasGrep}}- GNU grep BRE extensions are not guaranteed in the embedded shell: use `grep -E 'json|tool'` for alternation instead of `grep 'json\|tool'`; use the built-in `grep` tool with `pattern: "json|tool"` (Rust regex, so `\bword\b` works there){{#if hasEval}}, or `eval` for exact text processing{{/if}}.{{else}}- GNU grep BRE extensions are not guaranteed in the embedded shell: use `grep -E 'json|tool'` for alternation instead of `grep 'json\|tool'`{{#if hasEval}}, or use `eval` for exact text processing{{/if}}.{{/if}}

<instruction>
- `env: { NAME: "…" }` for multiline / quote-heavy / untrusted values; reference `$NAME`
- Quote expansions (`"$NAME"`) to preserve exact content
- `pty: true` only when the command needs a real terminal (`sudo`, `ssh` needing input); default `false`
- `;` only when later commands should run despite earlier failures
- Multiple bash calls per message run concurrently. NEVER split order-dependent commands across parallel calls — chain with `&&` in one call.
- Internal URIs (`skill://`, `agent://`, …) auto-resolve to FS paths
{{#if hasEval}}- Need exact pipeline semantics (`cmd | head`, multi-stage filtering) or output truncation? Prefer `eval` and process the stream directly.{{else}}- Need exact pipeline semantics (`cmd | head`, multi-stage filtering) or output truncation? Use a checked-in script, purpose-built tool, or single command that owns the output shape.{{/if}}
{{#if asyncEnabled}}
- `async: true` defers reporting for finite commands that need no later input; completion arrives as a follow-up.
{{/if}}
</instruction>

<critical>
{{#unless hasEval}}
- Writing a shell program rather than invoking a binary? Use a purpose-built tool or checked-in script.
{{/unless}}
{{#unless hasGrep}}
- Avoid shelling out for broad content search; use an active search/read tool when one is available.
{{/unless}}
{{#ifAll hasRead hasGlob}}
- `ls`/`find` are blocked in the shell, even for one quick listing: `ls` → `read`, `find` → `glob`.
{{/ifAll}}
{{#ifAll hasRead (not hasGlob)}}
- Prefer `read` for known file and directory reads. Only use shell listing when no file-listing tool is active.
{{/ifAll}}
{{#ifAll (not hasRead) hasGlob}}
- Prefer `glob` for file discovery; avoid `find` when `glob` is active.
{{/ifAll}}
{{#ifAll (not hasRead) (not hasGlob)}}
- If no file read/listing tool is active, keep shell inspection narrow and state that limitation.
{{/ifAll}}
- Avoid head/tail/redirections: stderr already merged; long output auto-truncated, FULL capture kept at `artifact://<id>`.
{{#if hasLaunch}}
- Long-running service, watcher, dev server, daemon, debugger, REPL, or anything needing later stdin? MUST use `launch`, never bash. NEVER `cmd &`, `nohup`, or async bash as a process supervisor.
{{/if}}
</critical>

<output>
- Returns output with stderr merged into stdout; a non-zero exit shows the exit code. Truncated output is linked as `artifact://<id>` in metadata.
</output>

{{#if asyncEnabled}}
# Timeout and async

- `timeout` is seconds, default 300, clamped to `1..3600`, and the process is killed on elapse. Set `timeout: 0` only for a finite command whose completion is cancellation-owned.
- `async: true` defers only reporting; it does NOT extend a nonzero timeout.
{{#unless hasLaunch}}
- Need a long-running process or >3600s run? Use an external process supervisor; avoid detached shell jobs you cannot later observe or stop.
{{/unless}}
{{/if}}

## Backgrounding a foreground call
{{#if autoBackgroundEnabled}}

- A long-running foreground call may convert to a background job after {{autoBackgroundSeconds}}s, and the operator can also background one by hand at any time. Either way the final result arrives as a follow-up tool call: NOT a failure, so don't retry or wait synchronously.
- Need the result inline (e.g. piping into another command)? Raise `timeout` above expected duration{{#if asyncEnabled}}, or set `async: true` up front{{/if}}.
{{/if}}
- `backgroundAfter` is seconds of foreground time for THIS call before it converts to a background job, overriding the configured default in both directions: raise it for a command whose output you need inline, lower it for one you know is slow. `backgroundAfter: 0` backgrounds immediately.
{{#if stallDetectionEnabled}}

## Stall detection

- A call that produces no new output for {{stallSeconds}}s is backgrounded and flagged as possibly stuck. The notice names the job id. This is a heuristic, NOT proof it is hung.
- Decide: if the command was expected to be quiet (a long compile, a sleep, a slow network wait), let it run — its result still arrives as a follow-up. If you believe it is genuinely hung, cancel it with the `job` tool (`cancel: ["<jobId>"]`).
{{/if}}

# Output minimizer

- Long output is truncated and test/lint runner output filtered to failures. A `[raw output: artifact://<id>]` footer appears whenever visible text changed: read it if a run looks suspicious or you need exact bytes. No footer means you saw exactly what the command emitted.
