# Startup budget

What veyyon does before a person sees anything, what it costs, and how to measure it again.

## Measure it

```sh
bun scripts/bench-startup.ts --runs 5                          # bun source, warm agent home
bun scripts/bench-startup.ts --runs 5 --bin ~/.local/bin/veyyon # the shipped binary
bun scripts/bench-startup.ts --runs 5 --cold                    # install-day, caches thrown away
```

The bench seeds its own agent home under `.captures/bench-startup/`, marked onboarded, so no run
measures the setup wizard and no run touches the machine's profile, sessions, or vault. `--cold`
deletes that home before every arm, because one arm otherwise warms the GPU cache and the model
catalog for the next.

Six arms:

| Arm | Measures |
| --- | --- |
| `version` | `--version`, which returns before the command registry loads: runtime init plus the entry module's graph. |
| `help` | `--help`, which loads the command registry. |
| `ready:load` | The timing tree's `(before instrumentation)` line: runtime init plus module load, before the first marker. |
| `ready:boot` | The timing tree's `Total`: every boot phase from the first marker to the TUI handoff. |
| `ready` | Wall time of an interactive launch under `VEYYON_TIMING=x`, which prints the tree and exits where the TUI would start. |
| `first-frame` | Wall time from spawn to the first byte the process writes to a pty. This is what a person waits for. |

`VEYYON_TIMING=x veyyon` prints the phase tree on its own, without the bench, and exits. `full`
adds every module-load span.

## Baseline

Linux x64, AMD Ryzen 9 9950X, medians of 3, measured at `96175566f`.

| Arm | Binary warm | Binary cold | Source warm | Source cold |
| --- | --- | --- | --- | --- |
| `version` | 94ms | 98ms | 41ms | 56ms |
| `help` | 464ms | 441ms | 692ms | 767ms |
| `ready:load` | 269ms | 298ms | 505ms | 573ms |
| `ready:boot` | 381ms | 944ms | 402ms | 680ms |
| `ready` | 715ms | 1290ms | 943ms | 1292ms |
| `first-frame` | 686ms | 1230ms | 937ms | 1397ms |

The binary is what a user runs. Source arms carry Bun's transpile cost and read pessimistic on
module load, optimistic on `version` because the entry module alone is small.

A first launch on a machine whose page cache holds neither the binary nor the agent home measured
3028ms to first byte. The bench cannot isolate that state, so it is recorded here and not in the
table.

## Where the time goes

From the tree, binary, warm, in order of cost:

- **Module load, 269ms.** Runtime init plus the static import graph reachable from `cli.ts`. Paid
  before any marker, so no phase can be blamed for it and no lazy import inside a phase reduces it.
- **`createAgentSession`, 150-320ms.** Context files, rules, watchdogs, advisor configs, prompt
  templates, slash commands, skills, tools, and the system prompt. Most children run in parallel;
  `buildSystemPrompt` dominates.
- **`getCachedGpu:getGpuModel`, 224-557ms cold, 0.6ms warm.** A hardware probe inside
  `buildSystemPrompt`, cached to disk after the first run. It used to be paid in full before the
  first frame; it now runs unwaited and writes the cache for the next launch, so one launch per
  machine omits the GPU row and none of them waits for it. The baseline table above was measured
  before that change, so a cold `ready:boot` re-measured today is lower than the number it records.
- **`modelRegistry:init` 43ms, `discoverAuthStorage` 35ms, `initTheme:final` 33ms.** Fixed cost, warm
  or cold.
- **`discoverAndLoadMCPTools`, off the pre-paint path.** With a UI it runs unwaited after the
  session is built, so it appears in the tree only when a launch has no UI to protect. A configured
  stdio server's spawn and `initialize` handshake are therefore paid concurrently with the first
  turn, not before the first frame.

## Measured deltas

Bun source, cold home, medians of 3, same machine.

| Arm | Before | After the GPU probe stopped blocking | Change |
| --- | --- | --- | --- |
| `ready:boot` | 680ms | 532ms | -148ms |
| `ready` | 1292ms | 1168ms | -124ms |
| `first-frame` | 1397ms | 1122ms | -275ms |

`version` and `ready:load` are unchanged within noise, which is the expected shape: the probe was
inside a boot phase, not in module load.

The first native call carries its own arm, measured separately because its cost comes from the
user's disk rather than from the code. Five runs per cell, fresh child process per run, a seeded
cache root holding three 150MiB dead version directories:

| First native call | No stale cache | 450MiB stale | Change |
| --- | --- | --- | --- |
| Prune inside `loadNative` | 124.9ms | 146.4ms | +17.2% |
| Prune handed to the event loop | 123.7ms | 123.0ms | -0.6% |

`cleanupStaleNativeVersions` ran between `dlopen` returning and the bindings reaching the caller,
so a launch paid for whatever dead cache was on disk: 7ms for one 150MiB directory, 24ms for three,
105ms for three that also held 5000 small files. `scheduleStaleNativeCleanup` hands the same prune
to the event loop with the unlink work off the calling thread. A process that exits within the tick
reclaims nothing and the next launch prunes instead, and `packages/natives/scripts/ensure-native.ts`
still prunes synchronously at install time, which is when a stale cache appears.

## What codex did

Techniques taken from openai/codex's own startup work, each with what it maps onto here.

- **Do not scan a growing store to answer a bounded question.** codex issue #38373 recorded a full
  session-database scan costing about 1.87s at startup on a large history; codex v0.147 took resume
  and fork from 3.58s to 0.23s. veyyon's boot tree shows no session-store read before the first
  frame — the recent list is built when it is asked for — so this is a property to keep rather than
  a cost to remove. Anything added to the pre-paint path that reads the session directory reopens it.
- **Start a subprocess when it is first used, not when it is configured.** codex#3726 made MCP
  servers start lazily. veyyon already defers this on the UI path: `deferMCPDiscoveryForUI` in
  `packages/coding-agent/src/sdk.ts` builds the manager, starts discovery without awaiting it, and
  delivers the tools through `refreshMCPTools` once the servers answer, so a hung server costs the
  first frame nothing. The headless path still awaits the connect, because a caller with no frame to
  protect expects a fully provisioned session on return.
  `packages/coding-agent/test/mcp/a-configured-server-never-delays-the-first-frame.test.ts` holds
  both halves: the fence is a server that never writes a byte.
- **Keep hardware and network out of the pre-paint path.** The GPU probe above is this technique
  applied: the answer is computed for the next launch instead of waited for by this one.

## Budget

- First frame within 150ms warm and 300ms cold, on the shipped binary.
- Nothing that probes hardware, the network, or an external process runs before the first frame.
- A phase added to the pre-paint path states its measured cost in the change that adds it.

The current binary misses the first target by 4.5x and the second by 4x, so the budget is a target
and not yet a gate. Wiring it to CI needs a runner whose timings are stable enough that a red build
means a regression; the numbers above vary by 30% across repetitions on an idle workstation.

*Verified against `a6d3fa8e4` on 2026-08-22.*
