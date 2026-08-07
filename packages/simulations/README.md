# @veyyon/simulations

Simulations, not unit tests.

A unit test simulates a component that behaves. The failures that reach users are
the ones where a component wedges: a stream that stops sending bytes, a tool that
never returns, an interrupt that is consumed twice. Those are hangs, and a mocked
seam cannot produce one. This package drives real subsystems end to end against
scripted, fully offline inputs, and awaits every scenario to completion, so a
missing bound shows up as a suite that times out.

## Layout

Each directory under `src/` is one family: a harness plus the scenarios that use
it, kept together.

| Family | What it drives |
|---|---|
| `src/turn-sim/` | One agent turn: a real `AgentSession` against a scripted provider |

Adding a family means adding a directory with its own `index.ts` and re-exporting
it from `src/index.ts`. Nothing else moves.

## Rules

- **Offline and deterministic.** No network, no API keys, no live models, no
  wall-clock sleeps. A scenario that needs time to pass drives the code's own
  configured budget.
- **No product edits.** This package reads other packages; it never patches them.
- **Every scenario is mutation-gated.** Re-inject the defect it claims to catch,
  watch it go red, restore. A scenario that stays green under its own mutation is
  a broken scenario, not a passing one.

## Running

```sh
export VEYYON_SANDBOX_REPO_ROOT="$(pwd -P)"
bash scripts/test-sandbox/run.sh --rung=docker bun test ./packages/simulations/src/turn-sim
```
