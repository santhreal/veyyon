# Mechanisms

This chapter is a compact map of the main harness mechanisms. It explains what each one is and points you to the chapter that covers it in full. The operator how-tos live under [Using](../using/getting-started.md) and [Features](../features/sandbox.md).

Veyyon is a fork of oh-my-pi. The first group below is what the fork adds on top. The rest is the shared base both projects run on.

## What the fork adds

- **Argot.** A per-project shorthand the model writes in. The model writes a short handle like `§build` where it would have written a long string it repeats, and Veyyon restores the full text before anything runs or is shown. The round trip is lossless, encoding is gated per model and by context size, and the generated dictionary is cached per project and only grows. See [Argot](./argot.md).
- **Snap compaction.** Bitmap-frame context compression with lossless dedup and artifact spill, so a long session sheds tokens without losing what it already established. See [Compaction and project memory](../context/compaction-memory.md).
- **Shared credentials and global config.** Providers and global settings are shared across profiles, so signing in once reaches every profile instead of each one holding its own copy.
- **Per-profile working directory.** A profile can pin its own working directory, and `setCwd` moves an existing session, so one install can hold several projects without them bleeding into each other.
- **Absolute-token compaction threshold.** Compaction can trigger on an absolute token count, not only a fraction of the window, so the trigger point is the same across models with different context sizes.
- **Atomic, serialized config writes.** Settings are written through a single serialized path with an atomic swap, so two writers never tear a config file.

## Hashline edits

The `edit` and `write` tools accept hashline patches, which are addressed by content rather than by line number. Before writing, the natives layer verifies the patch against the current file. If they do not match, the tool fails and returns recovery context to the model instead of writing a corrupted file.

See [Editing and repair](../using/editing.md) and [The hashline edit engine](../edit/engine.md).

## Tool approval tiers

The `tools.approvalMode` setting is one of `plan`, `ask`, `auto-edit`, or `yolo`. The older aliases `always-ask` and `write` still map to `ask` and `auto-edit`. On top of the mode, per-tool `tools.approval` overrides apply. The three tiers are read, write, and exec. Bash can still force a prompt on destructive patterns, depending on your execpolicy rules.

See [Approvals](../features/sandbox.md) and `/settings` then Advanced then Safety.

## Model slots and roles

Veyyon separates the model you use from the job it does:

- **The interactive model** is what you set with `/model` or `--model`, and it persists as `modelRoles.default`.
- **Roles** pin a model to a kind of work, such as `smol` for cheap fast work or `task` for subagents, and you can add your own in `modelRoles`. The full built-in set is listed in [Models, roles, and profiles](../using/roles-and-profiles.md).
- **Overrides** let a slot win over a role. `subagent.model` overrides `modelRoles.task` when set, and `compaction.model` overrides the interactive model for compaction, otherwise compaction inherits it.
- **Cycling** rotates through `cycleOrder` (which defaults to `smol` then `slow`), bound to `app.model.cycleForward`, often Ctrl+P.

The full contract is in [Models, roles, and profiles](../using/roles-and-profiles.md).

## Provider-neutral loop

The agent loop, the TUI, the session format, MCP, skills, hooks, and extensions do not hard-code a single vendor. You configure providers in the active profile's agent directory, through `config.yml`, `/setup`, or `/providers`.

## Engine modes

Compaction, goal continuation, plan mode, vibe mode, and task subagents live in the session and tool layer, not only in prompt text. Goal mode can keep an idle session moving toward a stored objective. Plan mode writes a plan file and holds back mutation until the resolve and approval paths complete.

## Profiles

Every profile, including `default`, lives at `~/.veyyon/profiles/<name>/agent/`, which holds its settings, sessions, MCP config, skills, and hooks. See [Profiles](../features/profiles.md) and [File locations](../reference/file-locations.md).

## Related

- [Design goals](../foundations/thesis.md)
- [Roles and profiles](../using/roles-and-profiles.md)
- [Repair](../repair/overview.md)
