# The Veyyon handbook

Veyyon is a coding agent that runs in your terminal and edits real code. It is built on one idea: a
capable open model does not need a frontier price tag to do frontier work. It needs the right harness
around it. Veyyon is that harness, tuned for how each model actually behaves.

This handbook is for everyone who uses Veyyon or wants to understand it.

- **Why Veyyon:** value, design map, and benefits you should feel first.
- **Install and first session:** install, providers, quickstart, configuration.
- **Everyday features:** editing, sandbox, models, sessions, themes.
- **Power features:** plan mode, goals, branching, MCP, plugins, memory, profiles.
- **How it works:** deeper engineering account for contributors.

If you read nothing else: [What Veyyon gives you](./why/value.md), [Getting started](./using/getting-started.md), [Editing and repair](./using/editing.md), [Models and providers](./using/models.md).

## What Veyyon is, in one paragraph

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi): TypeScript and Bun for the CLI, TUI, tools, providers, and session loop; Rust natives for grep, PTY, and **hashline** edits. Install via `bun install -g @veyyon/pi-coding-agent` or `bun dev` from source. The CLI command is **`veyyon`**. Config and state default to `~/.veyyon` (`PI_CONFIG_DIR` can override the directory name).

Shipped today: hashline edits, mnemopi memory, model roles, session trees, MCP, skills, and plan/goal modes.

## Why it is different (shipped vs planned)

- **Edits that land.** Hashline and model-tuned edit tools with native verification; fewer retry loops on bad diffs.
- **Explicit model slots.** Pick the model you talk to, the model for subagents, and the model for compaction — three plain choices, no `default`-chain indirection.
- **Honest interface.** Veyyon Dark uses the silver palette; plan/goal modes and tool approval tiers are engine features.

**Spec — not shipped:** the full schema-based tool-call repair cascade, a unified single-write-path proof, and self-contained profiles. See [What makes Veyyon different](./why/innovations.md).

## On honesty

This book states plainly what is built and what is planned. Pages marked **Spec — not shipped** describe target design not yet in the product. Credits: [Acknowledgements](./acknowledgements.md).
