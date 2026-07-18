# Mechanisms

Compact map of the main harness mechanisms. Operator how-tos live under [Using](../using/getting-started.md) and [Features](../features/sandbox.md).

## Hashline edits

`edit` and `write` accept hashline (content-addressed) patches. The natives layer verifies the patch against the current file before writing. On mismatch the tool fails with recovery context for the model.

See [Editing and repair](../using/editing.md) and [The hashline edit engine](../edit/engine.md).

## Tool approval tiers

`tools.approvalMode` is one of `plan`, `ask`, `auto-edit`, `yolo` (legacy aliases: `always-ask` → `ask`, `write` → `auto-edit`). Per-tool `tools.approval` overrides apply on top. Tiers are read, write, and exec. Bash can still force a prompt on destructive patterns depending on execpolicy rules.

See [Approvals](../features/sandbox.md) and `/settings` → Advanced → Safety. Detail also in `docs/approval-mode.md` in the repo.

## Model slots and roles

- **Interactive model** — `/model` / `--model`; persisted as `modelRoles.default`.
- **Roles** — `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `tiny`, `task`, `advisor` (+ custom) in `modelRoles`.
- **Overrides** — `subagent.model` (overrides `modelRoles.task` when set), `compaction.model` (else inherit interactive).
- **Cycle** — `cycleOrder` (default `smol`, `slow`); `app.model.cycleForward` (often Ctrl+P).

Full contract: [Models, roles, and profiles](../using/roles-and-profiles.md).

## Provider-neutral loop

The agent loop, TUI, session format, MCP, skills, hooks, and extensions do not hard-code a single vendor. Providers are configured in the active profile’s agent dir (`config.yml`, `/setup`, `/providers`).

## Engine modes

Compaction, goal continuation, plan mode, vibe mode, and task subagents are implemented in the session/tool layer. Goal mode can continue an idle session toward a stored objective. Plan mode writes a plan file and restricts mutation until resolve/approval paths complete.

## Profiles

Every profile (including `default`) lives at `~/.veyyon/profiles/<name>/agent/` (settings, sessions, MCP, skills, hooks, …). See [Profiles](../features/profiles.md) and [File locations](../reference/file-locations.md).

## Related

- [Design goals](../foundations/thesis.md)
- [Roles and profiles](../using/roles-and-profiles.md)
- [Repair](../repair/overview.md)
