# The Veyyon handbook

Veyyon is a terminal coding agent. You supply provider credentials; the process runs tools and edits files in your working tree.

This handbook covers installation, configuration, features, and harness structure.

| Section | Contents |
| --- | --- |
| [Why](./why/value.md) | Design goals and main mechanisms |
| [Using](./using/getting-started.md) | Install, providers, quickstart, configuration |
| [Features](./features/sandbox.md) | Editing, approvals, models, sessions, plan/goal, MCP, plugins, memory, profiles |
| [Architecture](./foundations/architecture.md) | Internals for contributors |

Start here if you are new: [Getting started](./using/getting-started.md), [Editing and repair](./using/editing.md), [Models and providers](./using/models.md).

## What Veyyon is

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi). The CLI, TUI, tools, providers, and session loop are TypeScript on Bun. Grep, PTY, and hashline apply paths use Rust natives (`@veyyon/natives`).

- Install: `bun install -g @veyyon/coding-agent` (or `bun setup && bun dev` from a source checkout)
- Binary: `veyyon` (alias `vey`)
- Config home: `~/.veyyon`; default profile agent dir: `~/.veyyon/profiles/default/agent/` (other profiles: `~/.veyyon/profiles/<name>/agent/`)

Main surfaces: hashline edits, tool loop (read/grep/glob/edit/bash/LSP/MCP/…), optional memory backends, model slots and roles, session trees, skills, plan mode, goal mode, task isolation for subagents.

## Mechanisms (summary)

- **Hashline edits.** `edit` / `write` apply content-addressed patches with verification before disk write; failures return structured errors to the model.
- **Model slots.** Interactive model (`/model`), subagent model, and compaction model are separate settings. Optional named roles pin models for specific work kinds.
- **Approvals.** `tools.approvalMode` gates read / write / exec tiers. There is no OS-level command sandbox (no Landlock, seccomp, Seatbelt, or bubblewrap).
- **Engine modes.** Plan mode, goal mode, vibe mode, compaction, and task subagents are implemented in the agent loop, not only as prompt text.

Credits and provenance: [Acknowledgements](./acknowledgements.md).
