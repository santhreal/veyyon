# Mechanisms

This chapter maps the mechanisms that shape Veyyon's behavior. It separates source provenance from the current product contract. The operator how-tos live under [Using](../using/getting-started.md) and [Features](../features/sandbox.md).

## Provenance boundary

Veyyon is a source fork of oh-my-pi. It retains the Bun and TypeScript agent loop, terminal UI, provider catalog, role routing, hashline edit engine, mnemopi memory, and the original native grep, PTY, and tree-sitter hot-path foundations. After the fork, Veyyon extracted reusable Rust crates for glob matching, grep orchestration, key normalization, text indexing, diffing, and directory walking. Those crate boundaries and their current contracts are post-fork work. The underlying grep and tree-sitter mechanisms are not Veyyon inventions.

## Current contracts and proof entry points

The table names the current product contract. A link in the **Recorded proof** column demonstrates only its link text, not every mechanism in that row. The provenance boundary above still applies to inherited mechanisms.

| Area | Current Veyyon contract | Recorded proof |
| --- | --- | --- |
| Prompt and context | Statement-owned prompt assembly, layered `AGENTS.md`, validated `PROMPT_SECTIONS/`, and transactional context reload when the working directory moves | [Section byte costs and the conditional section registry](../../../../assets/demo-prompt-architecture.gif) |
| Models and compaction | Model-native effort variants, explicit effort precedence, editable subsystem fallback chains, and a lossless first compaction pass | [Model-specific effort menus and before-and-after chain editing](../../../../assets/model-effort-controls.gif) and [manual compaction status with before-and-after context usage](../../../../assets/demo-context-compaction.gif) |
| Credentials and sessions | Shared SQLite credentials, multi-credential selection, encrypted working secrets, final outbound obfuscation, atomic session writes, and non-destructive corruption handling | [A project secret listed by placeholder, spent through bash, and recorded once in the value-free use log](../../../../assets/demo-secret-boundary.gif) |
| Tools and workers | One capability and tool registry, LSP write-through, destructive-shell interception, schema-validated workers, IRC, internal agent URLs, and the Agent Control Center | [An LSP reference lookup and subsequent test output](../../../../assets/demo-lsp-refactor.gif) and [parallel worker progress with live and idle Agent Control Center rows](../../../../assets/demo-agent-control-center.gif) |
| Native runtime | Inherited native grep and tree-sitter foundations, plus post-fork reusable Rust crates for glob matching, grep orchestration, key normalization, text indexing, diffing, and directory walking | No recording. See the [architecture and provenance reference](performance.md). |
| Argot | Lossless per-project shorthand that expands before a tool, transcript, parent agent, or display receives it | [One disabled Argot setting](../../../../assets/argot-settings-off.png) and [six enabled Argot settings](../../../../assets/argot-settings-on.png) |

The README section [What Veyyon changes](../../../../README.md#what-veyyon-changes) shows these contracts first. The repository's [upstream provenance](../../../../UPSTREAM.md) explains the fork boundary, and the [intentional-divergence ledger](../../../internal/porting-from-pi-mono.md#15-intentional-divergences) records port-sensitive implementation differences.

## Shared and evolved mechanisms

The sections below describe the current product. Some mechanisms began in the fork baseline, and some have changed since. Their behavior here is authoritative for Veyyon.

## Hashline edits

The `edit` and `write` tools accept hashline patches, which are addressed by content rather than by line number. Before writing, the natives layer verifies the patch against the current file. If they do not match, the tool fails and returns recovery context to the model instead of writing a corrupted file.

See [Editing and repair](../using/editing.md) and [The hashline edit engine](../edit/engine.md).

## Tool approval tiers

The `tools.approvalMode` setting is one of `plan`, `ask`, `auto-edit`, or `yolo`. The older aliases `always-ask` and `write` still map to `ask` and `auto-edit`. On top of the mode, per-tool `tools.approval` overrides apply. The three tiers are read, write, and exec. Bash can still force a prompt on destructive patterns through the bash interceptor (`bashInterceptor.enabled` and `bashInterceptor.patterns`).

See [Approvals](../features/sandbox.md) and `/settings` → Interaction → Approvals.

## Model slots and roles

Veyyon separates the model you use from the job it does:

- **The interactive model** is what you set with `/model` or `--model`, and it persists as `modelRoles.default`.
- **Roles** pin a model to a kind of work, such as `smol` for cheap fast work or `advisor` for the reviewing advisor, and you can add your own in `modelRoles`. The full built-in set is listed in [Models, roles, and profiles](../using/roles-and-profiles.md).
- **Overrides** let a slot win over a role. `compaction.model` overrides the interactive model for compaction, otherwise compaction inherits it. Subagent models are not roles at all: they live in the Subagents settings area, which owns them alone.
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
