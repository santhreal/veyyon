# Mechanisms

## Hashline edits

The `edit` and `write` tools accept hashline patches, which are addressed by content rather than by line number. Before writing, the native layer checks the patch against the current file. If they do not match, the tool fails and returns recovery context to the model instead of writing a corrupted file.

See [Editing and repair](../using/editing.md) and [The hashline edit engine](../edit/engine.md).

## Tool approval tiers

`tools.approvalMode` is one of `plan`, `ask`, `ask-command`, `auto`, or `yolo`.
`auto` is the default. Older names map onto those: `always-ask` to `ask`, `write`
and `auto-edit` to `ask-command`. The tiers are read, write, and exec.

Four guards sit above the mode and no mode lifts them:

- Per-tool overrides in `tools.approval`.
- The working-directory boundary.
- The secret-use boundary.
- `bash-guard.ts`, which forces a prompt on a destructive command such as a
  recursive delete of the home directory. `yolo` does not lift it.

`bashInterceptor.enabled` adds a user-configured layer on top, off by default,
matching `bashInterceptor.patterns`.

See [Approvals](../features/sandbox.md) and `/settings` -> Interaction ->
Approvals.

## Model slots and roles

Model configuration separates model selection from subsystem roles:

- **The interactive model** is set with `/model` or `--model` and persists as `modelRoles.default`.
- **Roles** pin a model to specific workloads, such as `smol` for lightweight operations or `advisor` for review. Custom roles are defined in `modelRoles`. See [Models, roles, and profiles](../using/roles-and-profiles.md).
- **Overrides** are explicit subsystem policies. `compaction.model` overrides the interactive model for compaction, otherwise compaction inherits it. Subagent models are configured via subagent policies in settings.
- **Cycling** rotates through `cycleOrder` (defaulting to `smol` then `slow`), bound to `app.model.cycleForward`.

## Provider-neutral loop

The agent loop, TUI, session format, MCP, skills, hooks, and extensions operate independently of specific model providers. Providers are configured in the active profile agent directory through `config.yml` or `/setup`, with account management via `/providers`.

## Engine modes

Compaction, goal continuation, plan mode, vibe mode, and task subagents live in the session and tool layer, not only in prompt text. Goal mode can keep an idle session moving toward a stored objective. Plan mode writes a plan file and holds back mutation until the resolve and approval paths complete.

## Profiles

Every profile, including `default`, lives at `~/.veyyon/profiles/<name>/agent/`, which holds its settings, sessions, MCP config, skills, and hooks. See [Profiles](../features/profiles.md) and [File locations](../reference/file-locations.md).

## Related

- [Design goals](../foundations/thesis.md)
- [Roles and profiles](../using/roles-and-profiles.md)
- [Repair](../repair/overview.md)
