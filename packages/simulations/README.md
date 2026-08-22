# @veyyon/simulations

Deterministic offline simulations for Veyyon agent subsystems. Drives production subsystems against scripted inputs to test lifecycle transitions, stream handling, and execution bounds without network calls.

## Layout

Each directory under `src/` implements a simulation suite:

| Suite | Scope |
|---|---|
| `src/turn-sim/` | Single agent turn execution with `AgentSession` against scripted provider responses |
| `src/cache-sim/` | Prompt-cache accounting, request generation, and provider cache simulations |

## Rules

- **Offline:** No network access, live model endpoints, or wall-clock sleeps.
- **Read-only:** Simulations test existing package contracts without modifying product code.

## Running

```sh
export VEYYON_SANDBOX_REPO_ROOT="$(pwd -P)"
bash scripts/test-sandbox/run.sh --rung=docker bun test ./packages/simulations/src/turn-sim
```
