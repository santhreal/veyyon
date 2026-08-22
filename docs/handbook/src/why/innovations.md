# Mechanisms

## Subsystem contracts

| Area | Mechanism |
| --- | --- |
| Prompt and context | Statement-owned prompt assembly, layered `AGENTS.md`, validated `PROMPT_SECTIONS/`, and transactional context reload when the working directory moves. |
| Models and compaction | Model-native effort variants, explicit effort precedence, editable subsystem fallback chains, and a lossless first compaction pass. |
| Credentials and sessions | Shared SQLite credentials, multi-credential selection, encrypted working secrets, outbound secret obfuscation, atomic session writes, and non-destructive corruption recovery. |
| Tools and workers | Unified tool registry, LSP write-through, destructive-shell interception, schema-checked workers, IRC bus, internal agent URLs, and the Agent Control Center. |
| Native runtime | Native grep, PTY handling, tree-sitter integration, and Rust crates for glob matching, grep orchestration, key normalization, text indexing, diffing, and directory walking. |
| Argot | Lossless per-project shorthand codec expanding before tools, transcripts, parent agents, or displays receive text. |

See [Acknowledgements](../acknowledgements.md) for project credits.

## Hashline edits

The `edit` and `write` tools accept hashline patches, which are addressed by content rather than by line number. Before writing, the native layer checks the patch against the current file. If they do not match, the tool fails and returns recovery context to the model instead of writing a corrupted file.

See [Editing and repair](../using/editing.md) and [The hashline edit engine](../edit/engine.md).

## Tool approval tiers

The `tools.approvalMode` setting is one of `plan`, `ask`, `ask-command`, `auto`, or `yolo`, and `auto` is the default. The older aliases still map onto those: `always-ask` → `ask`, `write` and `auto-edit` → `ask-command`. The three tiers are read, write, and exec. On top of the mode sit the guards the mode does not lift: per-tool `tools.approval` overrides, the working-directory boundary, the secret-use boundary, and a built-in bash guard (`bash-guard.ts`) that forces a prompt on destructive commands such as a recursive delete of the home directory. That guard is always on and even `yolo` does not lift it. The separate bash interceptor (`bashInterceptor.enabled`, off by default, `bashInterceptor.patterns`) is an additional user-configured layer.

See [Approvals](../features/sandbox.md) and `/settings` → Interaction → Approvals.

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
