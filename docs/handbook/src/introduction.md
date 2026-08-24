# The Veyyon handbook

Veyyon is a coding agent that runs in a terminal. Give it credentials for a model
provider and it works inside a project: it reads files, runs tools, and edits code in
place. Every step that touches the tree goes through an approval tier.

## Install

```sh
curl -fsSL https://get.veyyon.dev | sh
```

On Windows:

```powershell
irm https://veyyon.dev/install.ps1 | iex
```

The installer downloads a release binary and verifies its checksum. To build from
source, clone the repository and run `bun run setup && bun dev` in that checkout. See
[Install](./using/install.md) for platforms, pinned releases, updates, and uninstall.

The binary is `veyyon`, aliased to `vey`. Configuration lives under `~/.veyyon`; the
default profile keeps its state in `~/.veyyon/profiles/default/agent/`.

## Where things are

| Section | Contents |
| --- | --- |
| [Design and mechanisms](./why/index.md) | Design goals and the main subsystems |
| [Get started](./using/install.md) | Install, sign in, first task, providers |
| [Features](./features/sandbox.md) | Editing, approvals, models, sessions, plan and goal modes, MCP, plugins, memory, profiles |
| [Architecture](./foundations/architecture.md) | Internals |

## Implementation

The CLI, TUI, tools, providers, and session loop are TypeScript on Bun. Grep, glob,
PTY, and tree-sitter parsing are Rust natives in `@veyyon/natives`. The hashline edit
engine is TypeScript in `@veyyon/hashline`, with native helpers for block resolution.

- **Hashline edits.** `edit` and `write` apply content-addressed patches and verify
  them before anything reaches disk. A failed patch returns a structured error to the
  model instead of a half-written file.
- **Model slots.** The interactive model (`/model`), the subagent model, and the
  compaction model are separate settings. Named roles pin a model to a kind of work.
- **Approvals.** `tools.approvalMode` gates the read, write, and exec tiers. There is
  no operating-system sandbox: no Landlock, no seccomp, no Seatbelt, no bubblewrap.
  Approvals are the control point.
- **Engine modes.** Plan mode, goal mode, vibe mode, compaction, and task subagents
  live in the agent loop, not in prompt text.

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi). See
[Acknowledgements](./acknowledgements.md) for credits.
