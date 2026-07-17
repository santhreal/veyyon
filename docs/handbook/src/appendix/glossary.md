# Glossary

A concise vocabulary of the primitives that shape Veyyon's runtime behavior.

- **apply_patch**: Veyyon's structured edit tool. The model emits a `*** Begin Patch … *** End Patch` envelope, and the harness applies it through one verified path that checks for a unique match, respects the approval policy, and records the diff. It is delivered as a Freeform tool on the Responses API or as a Function tool with an `{input}` JSON field on Chat Completions.

- **approval mode**: The autonomy control (`tools.approvalMode`) that decides which tool tiers run automatically and which pause for your yes: `plan`, `ask`, `auto-edit`, `yolo` (legacy `always-ask` = `ask`, `write` = `auto-edit`). Veyyon does not add an OS command sandbox, so the mode is the boundary.

- **backend catalog**: The Tier-B data file that maps each model slug to a provider, wire API, and connection facts. Veyyon selects the model contract against this catalog rather than hardcoding provider lists.

- **compaction**: The compression layer that summarizes a long trajectory into a smaller, information-preserving form instead of truncating it. Compaction preserves the goal card, recent user messages, and deterministic working-set facts across successive windows.

- **edit / write**: The `edit` and `write` tools change files on disk. `write` creates or replaces a file; `edit` replaces exact text with new text. Both route through the same verified path as `apply_patch` and respect the approval policy.

- **Freeform tool / Function tool**: The two tool shapes Veyyon advertises to a model. A Freeform tool emits a raw grammar-shaped body; a Function tool emits JSON arguments matching a schema. The choice depends on the backend wire API.

- **goal state**: A structured goal card owned by the harness and stored in the state database. It keeps the objective, constraints, blockers, and completion criteria in a named context slot separate from the conversation tail so compaction cannot drop the user's intent.

- **hook**: A user-configured lifecycle handler that runs a command in response to events such as `PreToolUse`, `PostToolUse`, `PreCompact`, or `SessionStart`. Hooks can inject context, rewrite tool input, or block an action.

- **MCP**: Model Context Protocol, the bridge between Veyyon and external tools or data sources. Veyyon can consume MCP servers and can also run as an MCP server so other clients can delegate programming tasks to it.

- **model contract / BYOK**: The model contract is your chosen endpoint, model, and credentials. BYOK (bring-your-own-key) means you supply your own provider or local-endpoint key, so Veyyon calls the API directly without telemetry egress.

- **personality**: A style-only setting that changes how the agent writes replies without altering its tools or permissions. Built-in personalities include `pragmatic`, `friendly`, and `none`.

- **plugin**: A directory with a `.veyyon-plugin/plugin.json` manifest that adds skills, MCP servers, apps, hooks, or TUI customizations to Veyyon. Plugins are discovered through marketplaces.

- **profile**: A named configuration group (a per-profile `config.yml` under the agent directory) that bundles model, provider, approval mode, personality, and other runtime settings. Activate a profile at launch with `--profile` or at runtime with `/profile`.

- **prompt-cache discipline**: The practice of keeping stable prompt prefixes stable and treating cache behavior as measured runtime policy. Veyyon orders context and compacts in ways that preserve prefix stability across turns.

- **repair**: The layer that coerces a malformed-but-recoverable tool call into schema shape before dispatch, or fails loud with coaching when the call is unrepairable. It is protocol-agnostic and driven by the same schema the model was shown.

- **repair cascade**: The ordered set of sound transforms the repair engine applies to a tool call. Each rule returns a coerced value, a rule name for telemetry, and a coaching hint so the model stops re-malforming.

- **rollout**: The append-only JSONL log of a session's entries. Each entry carries an `id` and `parent_id`; a `leaf_move` line branches the active leaf to any earlier entry without rewriting history.

- **session**: The unit of interactive work in Veyyon. A session records turns, tool activity, approvals, edits, and verification output, and survives context pressure through goal state and compaction.

- **skill**: A reusable capability defined as data on the filesystem in a directory with a `SKILL.md` file. Skills are loaded from system, admin, user, project, and repository scopes and their instructions are injected into the system rules block.

- **thread / active leaf**: A thread is a linear sequence of messages within a session. The active leaf is the currently selected tip of the session tree that receives the next turn; branching moves the leaf without erasing sibling history.

- **tool call / repair**: A tool call is a model message that invokes a tool; repair is the harness layer that fixes malformed calls before dispatch so they land on the first attempt.

- **turn**: One complete model-invocation cycle in a session: the harness assembles context, the model responds, and any resulting tool calls are executed and repaired until the turn resolves.

- **verifier / stop-when-green**: The verifier checks whether a goal or task is satisfied. Stop-when-green is the policy of ending the turn loop once the verifier passes, so the agent does not waste budget after winning.

See also: [Sessions, turns, and threads](../concepts/sessions-turns-threads.md), [Permission model](../concepts/permission-model.md), [Model contract](../concepts/model-contract.md), [Repair overview](../repair/overview.md), and [Compaction and memory](../context/compaction-memory.md).
