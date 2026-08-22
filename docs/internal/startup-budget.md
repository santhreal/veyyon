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
  `buildSystemPrompt`, cached to disk after the first run. Install day pays it in full, before the
  first frame, for a line of prompt text no frame displays.
- **`modelRegistry:init` 43ms, `discoverAuthStorage` 35ms, `initTheme:final` 33ms.** Fixed cost, warm
  or cold.
- **`discoverAndLoadMCPTools`, 0.00ms** with no servers configured. A configured server moves this
  number onto the pre-paint path.

## Budget

- First frame within 150ms warm and 300ms cold, on the shipped binary.
- Nothing that probes hardware, the network, or an external process runs before the first frame.
- A phase added to the pre-paint path states its measured cost in the change that adds it.

The current binary misses the first target by 4.5x and the second by 4x, so the budget is a target
and not yet a gate. Wiring it to CI needs a runner whose timings are stable enough that a red build
means a regression; the numbers above vary by 30% across repetitions on an idle workstation.

*Verified against `96175566f` on 2026-08-22.*
