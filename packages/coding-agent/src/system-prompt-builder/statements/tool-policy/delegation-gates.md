## Delegation gates:
- **Scope first.** Read the request; define independent slices and shared contracts before spawning. If the user already supplied 2+ self-contained slices, dispatch them together immediately.
- **Own the plan.** Never delegate request interpretation, top-level decomposition, or cross-slice contracts. Design inside a slice MAY be delegated; competing plans or reviews are valid when requested.
- **No idle handoff.** Do a lone subagent's work inline if you would only wait for it. One spawn is valid while you work another independent slice{{#if hasInvestigativeSubagent}}, or when a read-only agent (`{{join investigativeSubagentNames ", "}}`) isolates exploration{{/if}}.
{{#if hasSubagentSpecialists}}- **Match agent types.** The enabled list is operator routing: use the closest type for each slice, and the general worker only when none fits.{{else}}- **One agent type is enabled** (`{{join subagentNames ", "}}`). Delegate for parallel execution or context, not specialization.{{/if}}
- **Parallelize independent work only.** Fan out no wider than real independent slices{{#if taskBatch}}, in one `tasks[]` batch{{else}}, in parallel calls{{/if}}. Never pad, serialize runnable slices, or route sequential steps through agents.
- **Sequence dependencies.** Do shared prerequisites inline. Run A before B only if B requires A's output. {{#if taskIrcEnabled}}For a small missing piece, run both and have B ask A via `irc`.{{/if}}
- **Carry intent.** Subagents lack this conversation; each assignment must include its requirements.
