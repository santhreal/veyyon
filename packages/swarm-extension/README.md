# @veyyon/swarm-extension

Multi-agent orchestration extension for Veyyon. Executes agent workflows defined in YAML files across pipeline, sequential, parallel, or directed acyclic graph (DAG) topologies.

Each agent runs as a subagent with access to tools (read, write, edit, bash, search, eval, web_search, browser). Agents communicate via files in the shared workspace directory.

## Setup

```bash
cd packages/swarm-extension
bun install
```

## Running

### Standalone CLI

```bash
# Foreground:
veyyon-swarm path/to/swarm.yaml

# Background:
nohup veyyon-swarm path/to/swarm.yaml > pipeline.log 2>&1 & disown
```

### In-session extension

Register the extension in `~/.veyyon/profiles/default/agent/config.yml` or pass `--extension packages/swarm-extension`:

```yaml
extensions:
  - packages/swarm-extension
```

Commands:

```
/swarm run path/to/swarm.yaml
/swarm status <name>
/swarm help
```

## State and monitoring

Pipeline state is written to `<workspace>/.swarm_<name>/`:

```
.swarm_<name>/
  state/pipeline.json    # Pipeline and agent execution status
  logs/orchestrator.log  # Wave transitions and iteration logs
  logs/<agent>.log       # Agent logs and error outputs
  context/               # Session artifacts
```

Inspect state:

```bash
# Formatted status JSON
cat workspace/.swarm_<name>/state/pipeline.json | python -m json.tool

# Follow orchestrator log
tail -f workspace/.swarm_<name>/logs/orchestrator.log
```

## YAML Reference

Root structure:

```yaml
swarm:
  name: my-pipeline
  workspace: ./workspace
  mode: pipeline
  target_count: 10
  model: claude-opus-4-6

  agents:
    first_agent:
      role: short-role-name
      task: |
        Agent instructions.
      extra_context: |
        Additional system prompt text.
      reports_to:
        - downstream_agent
      waits_for:
        - upstream_agent
      model: claude-sonnet-4-5
```

### Top-level fields

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `name` | Yes | None | Pipeline identifier. State stored in `.swarm_<name>/`. |
| `workspace` | Yes | None | Working directory path relative to YAML file. |
| `mode` | No | `sequential` | Execution mode (`pipeline`, `sequential`, `parallel`). |
| `target_count` | No | `1` | Number of iterations in `pipeline` mode. |
| `model` | No | Session default | Default model identifier for agents without an override. |

### Agent fields

| Field | Required | Description |
| --- | --- | --- |
| `role` | Yes | Role identifier used in agent system prompt. |
| `task` | Yes | Prompt instructions dispatched to agent. |
| `extra_context` | No | Supplementary text appended to system prompt. |
| `model` | No | Model override for this agent. |
| `reports_to` | No | List of agent names depending on this agent. |
| `waits_for` | No | List of agent names this agent depends on. |

### Execution modes

- `pipeline`: Repeats the agent dependency graph `target_count` times in waves.
- `sequential`: Runs agents once in declaration order unless explicit dependencies are set.
- `parallel`: Runs all agents concurrently in a single wave unless dependencies are set.

### Dependency resolution

The orchestrator builds a DAG from `waits_for` and `reports_to`, ordering agents into execution waves via topological sort. Cycles are rejected at startup.

## Topology examples

### Sequential pipeline

```yaml
swarm:
  name: doc-pipeline
  workspace: ./workspace
  mode: sequential

  agents:
    extractor:
      role: extractor
      task: |
        Extract key definitions from spec.md into extracted.txt.
    formatter:
      role: formatter
      task: |
        Read extracted.txt and generate formatted.md.
```

### Fan-out / fan-in (diamond DAG)

```yaml
swarm:
  name: feature-build
  workspace: ./workspace

  agents:
    planner:
      role: architect
      task: |
        Write implementation plan to plan.md.
      reports_to:
        - api
        - ui

    api:
      role: backend-dev
      task: |
        Read plan.md and implement API layer in src/api/.
      reports_to:
        - integrator

    ui:
      role: frontend-dev
      task: |
        Read plan.md and implement UI components in src/ui/.
      reports_to:
        - integrator

    integrator:
      role: tech-lead
      task: |
        Verify integration and write status to done.md.
```

## Architecture

```
src/extension.ts      TUI entry point (registers /swarm command)
src/cli.ts            Standalone CLI entry point
src/swarm/
  schema.ts           YAML validation
  dag.ts              Dependency graph and topological sorting
  executor.ts         Subprocess execution
  pipeline.ts         Wave controller and iteration loop
  state.ts            Filesystem state persistence
  render.ts           Progress rendering
```
