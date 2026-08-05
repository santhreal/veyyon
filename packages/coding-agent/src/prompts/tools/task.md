{{#if asyncEnabled}}{{#if batchEnabled}}Delegate work to background subagents by passing multiple items in a single `tasks[]` batch.{{else}}Delegate work to ONE background subagent per call.{{/if}}
Execution does not block your turn: you receive agent and job IDs immediately, and the final results deliver themselves when the subagents finish.{{#if hasBlockingAgents}}
Exception: agents marked BLOCKING below run inline — their results return in this call, while non-blocking items in the same batch still spawn as background jobs.{{/if}}{{else}}{{#if batchEnabled}}Run subagents synchronously by passing items in a `tasks[]` batch.{{else}}Run ONE subagent synchronously per call.{{/if}}
Execution blocks your turn: the call only returns once the work is completely finished.{{/if}}

# Task Design
- **No overhead:** Each `task` MUST instruct its agent to skip formatters, linters, and project-wide test suites. You will run those once at the end.
- **One-pass agents:** Prefer agents that investigate **and** edit in a single pass. Use a read-only agent only for investigation and reporting.

# Inputs
{{#if batchEnabled}}
- `context`: Shared project state, constraints, and contracts. Applies to the entire batch; do not duplicate this background into individual tasks.
- `tasks[]`: Array of subagents to spawn.
  - `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
  - `agent`: The enabled agent type running this item.{{#if hasDefaultAgent}} Omitting it uses the configured default (`{{defaultAgent}}`).{{else}} Required because no enabled default agent exists.{{/if}}{{#if allowedAgentsText}} Enabled and allowed: {{allowedAgentsText}}.{{/if}}
  - `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
{{#if isolationEnabled}}
  - `isolated`: Run in a dedicated worktree and return patches. Isolated agents are destroyed upon completion and cannot be addressed afterward.
{{/if}}
{{else}}
- `name`: A stable CamelCase identifier (≤32 chars), used to address the agent (IRC, job ids). Generated automatically if omitted.
- `agent`: The enabled agent type to spawn.{{#if hasDefaultAgent}} Omitting it uses the configured default (`{{defaultAgent}}`).{{else}} Required because no enabled default agent exists.{{/if}}{{#if allowedAgentsText}} Enabled and allowed: {{allowedAgentsText}}.{{/if}}
- `task`: Complete, self-contained instructions. One-liners or missing acceptance criteria are PROHIBITED.
{{#if isolationEnabled}}
- `isolated`: Run in a dedicated worktree and return patches. Isolated agents are destroyed upon completion and cannot be addressed afterward.
{{/if}}
{{/if}}

# Context and Communication
Subagents start blank. They have no access to your conversation history.
{{#if ircEnabled}}- **Steering delivery:** Parent-to-subagent IRC is delivered immediately as steering; subagents blocked in `job poll` / `irc wait` do not need to poll separately for it.{{/if}}
{{#if batchEnabled}}
- Pass large payloads using `local://<path>` URIs, NEVER inline text.
{{else}}
- Write shared project state ONCE to a `local://` file (e.g., `local://ctx.md`) and reference that URL in each `task`.
{{/if}}

# Format Contracts
{{#if batchEnabled}}
The `context` field MUST follow this format:
# Goal         ← what the batch accomplishes
# Constraints  ← rules and session decisions
# Contract     ← shared interfaces
{{/if}}

The `task` field MUST follow this format:
# Target       ← exact files and symbols; explicit non-goals
# Change       ← step-by-step add/remove/rename; APIs and patterns
# Acceptance   ← observable result; no project-wide commands

# Available Agents
{{#if spawningDisabled}}
Agent spawning is currently disabled.
{{else}}
Pick the most specific enabled agent for each task.{{#if hasDefaultAgent}} Use the default only when no specialist below fits.{{/if}}
{{#list agents join="\n"}}
### {{name}}{{#if readOnly}} (READ-ONLY: no edit/write/command tools){{/if}}{{#if blocking}} (BLOCKING: runs inline; its result returns in this call){{/if}}
{{description}}
{{#if readOnly}}Use ONLY for investigation and reporting; do the edits yourself or assign them to a writing agent.{{/if}}
{{/list}}
{{/if}}
