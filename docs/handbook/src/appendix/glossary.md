# Glossary

A concise vocabulary of the primitives that shape Veyyon's runtime behavior.

- **apply_patch**: Edit mode (`edit.mode: apply_patch`) for a Codex-style `*** Begin Patch … *** End Patch` envelope. Default edit mode is **hashline** via the `edit` tool. Apply-patch shares approval policy with other write paths.

- **approval mode**: The autonomy control (`tools.approvalMode`) for tool tiers: `plan`, `ask`, `auto-edit`, `yolo` (legacy `always-ask` → `ask`, `write` → `auto-edit`). There is no OS command sandbox; the mode (plus execpolicy) is the boundary.

- **model catalog**: Bundled provider/model data plus `models.yml` / `models.yaml` custom entries. There is no separate `backends.toml` subsystem.

- **compaction**: The compression layer that summarizes a long trajectory into a smaller, information-preserving form instead of truncating it. Compaction preserves the goal card, recent user messages, and deterministic working-set facts across successive windows.

- **edit / write**: The `edit` and `write` tools change files on disk. Default `edit` is hashline (content-hash anchors); `write` creates or overwrites a whole file. Both respect `tools.approvalMode`.

- **Freeform tool / Function tool**: The two tool shapes Veyyon advertises to a model. A Freeform tool emits a raw grammar-shaped body; a Function tool emits JSON arguments matching a schema. The choice depends on the backend wire API.

- **goal state**: A structured goal card on the session (session-backed). Holds the objective and lifecycle fields, injected outside the raw conversation tail so compaction does not drop intent.

- **hook**: A TypeScript module that default-exports a factory and registers handlers with `pi.on(...)` (events such as `tool_call`, `tool_result`, `session`). Can block tools, inject context, or register commands. See [Hooks](../features/hooks.md).

- **MCP**: Model Context Protocol. Veyyon is an MCP **client** that connects to external MCP servers and exposes their tools as `mcp__…`. Editor embedding uses ACP (`veyyon acp`), which is a different protocol.

- **model contract / BYOK**: The model contract is your chosen endpoint, model, and credentials. BYOK (bring-your-own-key) means you supply your own provider or local-endpoint key; Veyyon calls that API with your credentials. Optional OTEL export is separate and only when configured.

- **personality**: Style-only system prompt block. Built-ins include `default`, `pragmatic`, `friendly`, and `none`.

- **plugin**: A directory with a `.veyyon-plugin/plugin.json` manifest that can add skills, MCP servers, hooks, and related assets. Plugins are discovered through marketplaces.

- **profile**: A directory under `~/.veyyon/profiles/<name>/` (including `default`) holding agent settings, sessions, MCP, skills, and related state. Activate with `--profile`, `VEYYON_PROFILE`, or `/profile` (relaunch).

- **prompt-cache discipline**: Keeping stable prompt prefixes byte-stable so provider prompt caches hit; context order and compaction are designed around that.

- **repair**: Schema-based coercion of malformed tool-call arguments before validation; ambiguous cases return an error tool result (no dispatch). See [Repair](../repair/overview.md).

- **repair cascade**: The ordered set of sound transforms the repair engine applies to a tool call. Each rule returns a coerced value, a rule name for telemetry, and a coaching hint.

- **rollout**: The append-only JSONL log of a session's entries. Each entry carries an `id` and `parent_id`; a `leaf_move` line branches the active leaf to any earlier entry without rewriting history.

- **session**: The unit of interactive work in Veyyon. A session records turns, tool activity, approvals, edits, and verification output, 

- **skill**: Filesystem package with a `SKILL.md`. Discovered from profile/project skill dirs, managed-skills, plugins, and optional foreign-tool layouts. Metadata enters the system prompt; body is read via `skill://`.

- **thread / active leaf**: A thread is a linear sequence of messages within a session. The active leaf is the currently selected tip of the session tree that receives the next turn; branching moves the leaf without erasing sibling history.

- **tool call**: A model message that invokes a tool by name with arguments. Repair may coerce malformed arguments before validation.

- **turn**: One model-invocation cycle: assemble context, model response, tool calls until the turn ends.

- **verifier / stop-when-green**: Checks whether a goal or task is satisfied. Stop-when-green ends the turn loop once verification passes.

See also: [Sessions, turns, and threads](../concepts/sessions-turns-threads.md), [Permission model](../concepts/permission-model.md), [Model contract](../concepts/model-contract.md), [Repair overview](../repair/overview.md), and [Compaction and memory](../context/compaction-memory.md).
