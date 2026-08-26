{{#ifAll hasEval launch}}Execute persistent code evaluation cells or supervise long-running background processes.{{else}}{{#if hasEval}}Run one step of code in a persistent kernel.{{/if}}{{#if launch}}Supervises a process that does NOT end on its own, shared by every veyyon instance in the same directory.{{/if}}{{/ifAll}}

<routing>
- Pick by how the process ENDS, never by how long it runs.
{{#if hasEval}}- `op="exec"`: Run one step of code in a persistent evaluation kernel. State persists per language across calls within each language. Use for computation, data inspection, rapid iteration, script-like workflows, or multi-step logic.
{{/if}}{{#if launch}}- Launch operations (`start`, `logs`, `wait`, `send`, `stop`, `restart`, `list`, `describe`): Supervise processes that do NOT end on their own (servers, daemons, watchers, REPLs). A supervised process reports its own exit as a background job, so you never poll.
{{/if}}- Ends on its own with a final exit code (test suite, build, benchmark, migration, install — any command with a last line)? That is `bash`, backgrounded if it is slow.
</routing>

<instruction>
{{#if hasEval}}## Kernel Evaluation (`op="exec"`)
**One exec call = one cell = one logical step.** State persists per language across exec calls, tool calls, and `task` subagents, so imports go in one call, definitions in the next, then the test, then the use, each its own call. Parallelize *within* a cell with `parallel(thunks)`, never by batching steps.

Fields:
- `language` (required) — {{#if py}}`"py"` IPython kernel{{/if}}{{#ifAll py js}}, {{/ifAll}}{{#if js}}`"js"` persistent JavaScript VM{{/if}}{{#if rb}}{{#ifAny py js}}, {{/ifAny}}`"rb"` persistent Ruby kernel{{/if}}{{#if jl}}{{#ifAny py js rb}}, {{/ifAny}}`"jl"` persistent Julia kernel{{/if}}.
- `code` (required) — cell body, verbatim. Newlines/quotes JSON-encoded; no fences, no headers.
- `title` (optional) — short transcript label (e.g. `"imports"`).
- `timeout` (optional) — seconds; default 30, clamped to 1-3600; `0` disables the cell timeout. Raise only for heavy compute or long non-agent tool calls.
- `reset` (optional) — wipe this language's kernel before running.{{#ifAll py js}} Per-language: a `py` reset never touches the JS VM.{{/ifAll}}

{{#if py}}Live event loop: use top-level `await` directly; `asyncio.run(…)` raises "cannot be called from a running event loop".{{/if}}
{{#if js}}JS runs under **Bun**: Bun globals/APIs are available (`Bun.file`, `Bun.write`, `Bun.$`, `fetch`, `Buffer`); top-level `await`/`return` work directly.{{/if}}
{{#if rb}}Ruby: synchronous; helper options are keyword args (e.g. `output("id", limit: 2)`); the last expression auto-displays unless it is `nil`, an assignment, or a definition (like IRB).{{/if}}
{{#if jl}}Julia: synchronous; helper options are standard keyword args (e.g. `output("id", limit=2)`); the last expression auto-displays unless it is an assignment or a definition (like the Julia REPL).{{/if}}
On error, fix and re-run only the failing step — prior calls' state survives.
{{/if}}
{{#if launch}}## Process Supervision (`start`, `logs`, `wait`, `send`, `stop`, `restart`, `list`, `describe`)
- The schema documents every field; these are the facts it cannot state.
- `start` BLOCKS until readiness or `ready.timeout`, so a pattern that never prints costs the whole timeout. Without `ready` it returns as soon as the process is spawned.
- Names are unique per project directory. A completed name MAY be started again; a live name MUST be stopped or restarted.
- Every op except `start` and `list` addresses the stable `name`.
- `logs` with `follow` returns a cursor; pass it back on the next call to continue where you stopped.
- `wait` blocks. An exit already arrives on its own, so `wait` is for readiness or a pattern you need before the next step — never a poll loop.
- `send.keys` accepts ENTER, TAB, ESCAPE, CTRL_C, CTRL_D, UP, DOWN, LEFT, RIGHT. PTY input is serialized: many clients MAY observe, but writes share one input stream.
- `stop` terminates the process tree gracefully before hard-kill; `restart` reuses the retained spec. Neither reports an exit you asked for, and `on-failure`/`always` restarts use bounded backoff.
- The broker stops every non-persistent process once the last veyyon in this directory exits. `persist` opts out of that; `detached` also survives broker shutdown and reports no exit.
{{/if}}</instruction>

{{#if hasEval}}<prelude>
{{#ifAll py js}}Same helpers + arg order, both runtimes. Python: sync, options = trailing kwargs. JS: async/`await`able, options = ONE trailing object literal, never positional (extras throw).{{else}}{{#if py}}Sync; options = trailing kwargs.{{/if}}{{#if js}}Async/`await`able; options = ONE trailing object literal, never positional (extras throw).{{/if}}{{/ifAll}}{{#if rb}} Ruby: sync, options = trailing keyword args.{{/if}}{{#if jl}} Julia: sync, options = trailing keyword args.{{/if}}
```
display(value) → None
    Cell output; figures/images/dataframes shown natively.
print(value, ...) → None
    Text output.
read(path, offset?=1, limit?=None) → str
    File/resource text; offset/limit = 1-indexed lines. `local://…` works everywhere; Python/JS also accept top-level `read` URI schemes.
write(path, content) → str
    Write file (creates parents) → resolved path. `local://…` persists across turns/subagents.
env(key?=None, value?=None) → str | None | dict
    No args → full env dict; one → value of `key`; two → set `key=value`, return value.
output(*ids, format?="raw", query?=None, offset?=None, limit?=None) → str | dict | list[dict]
    Task/agent output by id; one → text/dict, multiple → list.
tool.<name>(args) → unknown
    Invoke any session tool; `args` = its parameter object.
completion(prompt, model?="default", system?=None, schema?=None) → str | dict
    Oneshot, stateless (no history/tools). `model`: "smol" | "default" | "slow". `schema` (JSON-Schema) → parsed structured output.
{{#if spawns}}
{{#if hasSpawnDefaultAgent}}agent(prompt, agent?="{{spawnDefaultAgent}}", model?=None, label?=None, schema?=None, handle?=False) → str | dict
    Run a subagent → final output. `agent` picks another enabled agent; omit it to use `{{spawnDefaultAgent}}`.{{else}}agent(prompt, agent, model?=None, label?=None, schema?=None, handle?=False) → str | dict
    Run a subagent → final output. `agent` must name an enabled agent.{{/if}}{{#if spawnAllowedAgentsText}} {{spawnAgentListLabel}}: {{spawnAllowedAgentsText}}.{{/if}} `schema` as in completion(). Background via `local://` files named in the prompt. `handle` → DAG node dict { text, output, handle: "agent://<id>", id, agent } (parsed under `data` when `schema` set).
{{#if js}}    JS: options are ONE trailing object — agent(prompt, { agent, schema, handle }).
{{/if}}
{{/if}}
parallel(thunks) → list
    Thunks through a bounded pool (wide as a `task` batch; don't pre-shrink), input order kept; returns when all finish, a throwing thunk propagates.
pipeline(items, ...stages) → list
    Map items through one-arg stages left-to-right, barrier between stages; stage 1 gets the item, later stages the previous result.
log(message) → None
    Progress line above the status tree.
phase(title) → None
    Phase grouping subsequent status lines.
budget → per-turn token budget
    {{#if py}}`budget.total` (ceiling or None), `budget.spent()`, `budget.remaining()` (math.inf when no ceiling), `budget.hard`.{{/if}}{{#if js}}`await budget.total()` (ceiling or null), `await budget.spent()`, `await budget.remaining()` (Infinity when no ceiling), `await budget.hard()`.{{/if}}{{#if rb}} Ruby: `budget.total` (ceiling or nil), `budget.spent`, `budget.remaining` (Float::INFINITY when no ceiling), `budget.hard`.{{/if}}{{#if jl}} Julia: `budget.total` (ceiling or nothing), `budget.spent()`, `budget.remaining()` (Inf when no ceiling), `budget.hard`.{{/if}} Ceiling: `+Nk` (advisory) or `+Nk!`/Goal Mode (hard — `agent()` won't spawn past it); spend still tracked.
```
</prelude>
{{#if spawns}}
<dag>
Pipe handles through stage helpers to build an acyclic dependency graph:
- **Name nodes.** Capture each `agent(…, {{#if py}}handle=True{{/if}}{{#if js}}{ handle: true }{{/if}}{{#if jl}}handle=true{{/if}})` result; carries `handle` (`agent://<id>`) + `output`.
- **Wire edges by reference.** Put an upstream node's `handle`/`output` in the dependent stage's prompt, so a large transcript is never re-inlined. Bulk: `write("local://<name>.md", …)` and pass the URI.
- **`pipeline(items, *stages)` = staged waves**, barrier between stages (every item clears stage N before any enters N+1). **`parallel(thunks)` = one wave** of independent nodes.
- **Isolate failure.** A raising node re-raises the lowest-index error and aborts its wave; wrap risky nodes so a failure degrades only its dependent subtree.
- **Acyclic only.** A node never waits on its own descendant.
</dag>
{{/if}}
{{/if}}

<critical>
{{#if launch}}- Readiness MUST be observed; process creation alone is not readiness.
- Use `stop`; NEVER kill an unverified PID through bash.
{{/if}}{{#if hasEval}}- Prior top-level names (`data`, `sessions`, helpers, imports) survive into the next exec call — reuse them; NEVER re-import, re-require, or re-declare a helper. Re-read a file only if it may have changed since the last read. Re-run setup only after `reset`, a crash, or a `NameError`/`ReferenceError`.
{{/if}}</critical>
