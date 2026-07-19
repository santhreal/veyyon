# The Veyyon handbook

Welcome. Veyyon is a coding agent that runs in your terminal. You give it credentials for a model provider, and it works inside your project: it reads files, runs tools, and edits your code in place, one reviewable step at a time. You stay in the loop, and you approve the work that touches your tree.

This handbook teaches Veyyon from the ground up. It begins with installation and your first session, then explains the ideas the rest of the tool is built on, and finally covers each feature and the internals a contributor needs. You do not have to read it front to back. The early chapters assume less than the later ones, so if Veyyon is new to you, following the order will save you time.

## Who this book is for

You are comfortable at a command line, and you want a coding agent you can watch and steer rather than one that changes your files out of sight. You do not need to know Rust or TypeScript to use Veyyon. You do need a working terminal and an API key or a sign-in for at least one provider. The Architecture chapters go deeper, for readers who want to contribute to Veyyon itself.

## How to read this book

The book is arranged in the order you tend to need it.

| Section | What it covers |
| --- | --- |
| [Why](./why/value.md) | The design goals and the main mechanisms, so the rest makes sense |
| [Using](./using/getting-started.md) | Install, sign in, run your first task, configure providers |
| [Features](./features/sandbox.md) | Editing, approvals, models, sessions, plan and goal modes, MCP, plugins, memory, profiles |
| [Architecture](./foundations/architecture.md) | The internals, for contributors |

If you only want to get to work, read [Install](./using/install.md), sign in, and go to [Getting started](./using/getting-started.md). Come back to the concept chapters when something surprises you. They explain why Veyyon behaves the way it does, which is usually faster than guessing.

## What Veyyon is

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi). The CLI, the TUI, the tools, the providers, and the session loop are TypeScript running on Bun. The hot paths, meaning grep, PTY, and hashline patch application, are Rust natives in `@veyyon/natives`.

A few facts you will reach for often:

- Install with `bun install -g @veyyon/coding-agent`, or run `bun setup && bun dev` from a source checkout.
- The binary is `veyyon`, with the shorter alias `vey`.
- Configuration lives under `~/.veyyon`. The default profile keeps its agent state in `~/.veyyon/profiles/default/agent/`, and other profiles use `~/.veyyon/profiles/<name>/agent/`.

The surfaces you will meet in the rest of the book are hashline edits, the tool loop (read, grep, glob, edit, bash, LSP, MCP, and more), optional memory backends, model slots and roles, session trees, skills, plan mode, goal mode, and task isolation for subagents.

## Mechanisms at a glance

Each of these has its own chapter later. This list is a map, not the full explanation.

- **Hashline edits.** The `edit` and `write` tools apply content-addressed patches and verify them before anything reaches disk. A failed patch returns a structured error to the model instead of a half-written file.
- **Model slots.** The interactive model (`/model`), the subagent model, and the compaction model are separate settings. Named roles can pin a model to a specific kind of work.
- **Approvals.** The `tools.approvalMode` setting gates the read, write, and exec tiers. Veyyon does not add an operating-system command sandbox. It does not use Landlock, seccomp, Seatbelt, or bubblewrap, so approvals are your control point.
- **Engine modes.** Plan mode, goal mode, vibe mode, compaction, and task subagents live in the agent loop itself, not only in prompt text.

For credits and provenance, see [Acknowledgements](./acknowledgements.md).
