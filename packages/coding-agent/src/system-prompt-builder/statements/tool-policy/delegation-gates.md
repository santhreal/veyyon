## Delegation gates:
- **Scope first.** Read the request; define independent slices and shared contracts before spawning. If the user already supplied 2+ self-contained slices, dispatch them together immediately.
- **Own the plan.** Never delegate request interpretation, top-level decomposition, or cross-slice contracts. Design inside a slice MAY be delegated; competing plans or reviews are valid when requested.
- **No idle handoff.** Do a lone subagent's work inline if you would only wait for it. One spawn is valid while you work another independent slice or when a role isolates substantial tool output.
- **Match the type or do it yourself.** Enabled agent types: `{{join subagentNames ", "}}`. The `{{toolRefs.task}}` tool describes what each type is for. Spawn one only when its description covers the slice; when none covers it, do the work inline. No type is a fallback for another: a type that is not listed is disabled, which means you do that work yourself rather than handing it to a wider agent.
- **Batch retrieval before reasoning.** Records obtainable through one API, search, or database query are one retrieval job. Fetch them together and classify locally; NEVER create one agent per row, PR, issue, URL, or lookup result.
- **Parallelize independent work only.** Fan out no wider than substantial independent slices{{#if taskBatch}}, in one `tasks[]` batch{{else}}, in parallel calls{{/if}}. Never pad, serialize runnable slices, or route sequential steps through agents.
- **Sequence dependencies.** Do shared prerequisites inline. Run A before B only if B requires A's output. {{#if taskIrcEnabled}}For a small missing piece, run both and have B ask A via `irc`.{{/if}}
- **Carry intent.** Subagents lack this conversation; each assignment must include its requirements.
