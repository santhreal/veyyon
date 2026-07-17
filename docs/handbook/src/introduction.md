# The Veyyon handbook

Veyyon runs in your terminal and edits real code. Bring your own model keys; the harness is tuned for coding work, not chat theater.

This handbook is for everyone who uses Veyyon or wants to understand it.

- **Why Veyyon:** value, design map, and benefits you should feel first.
- **Install and first session:** install, providers, quickstart, configuration.
- **Everyday features:** editing, approvals, models, sessions, themes.
- **Power features:** plan mode, goals, branching, MCP, plugins, memory, profiles.
- **How it works:** deeper engineering account for contributors.

If you read nothing else: [What Veyyon gives you](./why/value.md), [Getting started](./using/getting-started.md), [Editing and repair](./using/editing.md), [Models and providers](./using/models.md).

## What Veyyon is, in one paragraph

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi): TypeScript and Bun for the CLI, TUI, tools, providers, and session loop; Rust natives for grep, PTY, and **hashline** edits. Install with `bun install -g @veyyon/pi-coding-agent` or `bun dev` from source. The command is **`veyyon`** (short alias **`vey`**). Config and state default to `~/.veyyon`.

Shipped today: hashline edits, mnemopi memory, model roles, session trees, MCP, skills, and plan/goal modes.

## Why it is different (shipped vs planned)

- **Edits that land.** Hashline and model-tuned edit tools with native verification; fewer retry loops on bad diffs.
- **Explicit model slots.** Pick the model you talk to, the model for subagents, and the model for compaction — three plain choices, no `default`-chain indirection.
- **Interface.** Veyyon Dark uses the silver palette; plan/goal modes and tool approval tiers are engine features.

**Spec — not shipped:** the full schema-based tool-call repair cascade, a unified single-write-path proof, and self-contained profiles. See [What makes Veyyon different](./why/innovations.md).

## What is built vs planned

This book states plainly what is built and what is planned. Pages marked **Spec — not shipped** describe target design not yet in the product. Credits: [Acknowledgements](./acknowledgements.md).
