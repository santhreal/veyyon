/**
 * The `agent/` prompt rows: what a delegated agent runs under.
 *
 * WHY EACH DIRECTORY OWNS ITS OWN ROWS. `registry.ts` is still the ONE place that says which prompts exist,
 * and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }`
 * specifiers no longer sit in a single module. They did, and the consequence was that importing one prompt
 * statically reached all 163: `tools/fs/read.ts` needs `PROMPTS["tools/read"]` to render its own description and
 * paid 167 modules for it, the largest single edge that file had. A consumer now imports the directory it
 * belongs to and pays for that directory.
 *
 * THE INVARIANT IS UNCHANGED AND IS CHECKED ONE LEVEL DEEPER. Every `.md` under `src/prompts/` is imported by
 * exactly one row module, every row module is aggregated by `registry.ts`, and nothing else in the repository
 * may import a `.md`. `packages/coding-agent/test/core/prompt-registry-coverage.test.ts` pins all three, so a
 * new prompt is still unreachable code until it is registered, and a row still cannot describe a file that is
 * not there.
 *
 * DO NOT re-declare a row that another module already holds. The id-to-file mapping exists exactly once, here
 * for these ids, and the coverage suite fails on a second importer.
 */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import agentCreationArchitect from "./agent-creation-architect.md" with { type: "text" };
import agentCreationUser from "./agent-creation-user.md" with { type: "text" };
import agentOrchestrateNotice from "./orchestrate-notice.md" with { type: "text" };
import agentSystemPrompt from "./system-prompt.md" with { type: "text" };
import agentTaskLabel from "./task-label.md" with { type: "text" };
import agentUserPrompt from "./user-prompt.md" with { type: "text" };
import agentWorkflowNotice from "./workflow-notice.md" with { type: "text" };
import agentYieldReminder from "./yield-reminder.md" with { type: "text" };
import agentYieldSchemaRepair from "./yield-schema-repair.md" with { type: "text" };

/** Every prompt under `src/prompts/agent/`, keyed by its id (the path under `src/prompts/`). */
export const agentPrompts = definePromptRows({
	"agent/agent-creation-architect": {
		text: agentCreationArchitect,
		purpose: "designs a new agent definition from a description",
	},
	"agent/agent-creation-user": {
		text: agentCreationUser,
		purpose: "the user half of agent creation, carrying the request",
	},
	"agent/orchestrate-notice": {
		text: agentOrchestrateNotice,
		purpose: "recasts the user's message as an orchestration contract",
	},
	"agent/system-prompt": {
		text: agentSystemPrompt,
		purpose: "the system prompt a delegated task runs under",
		sections: [
			{ id: "role", name: "ROLE", purpose: "the agent definition the caller selected", optional: false },
			{
				id: "context",
				name: "CONTEXT",
				purpose: "caller-supplied context for this assignment",
				optional: true,
			},
			{ id: "plan", name: "PLAN", purpose: "the approved plan this assignment is part of", optional: true },
			{
				id: "coop",
				name: "COOP",
				purpose: "working-tree isolation and IRC peer coordination",
				optional: false,
			},
			{
				id: "completion",
				name: "COMPLETION",
				purpose: "yield protocol, output schema, and the no-giving-up contract",
				optional: false,
			},
		],
	},
	"agent/task-label": { text: agentTaskLabel, purpose: "labels a delegated assignment in one short sentence" },
	"agent/user-prompt": {
		text: agentUserPrompt,
		purpose: "the user half of a delegated task, carrying the assignment",
	},
	"agent/workflow-notice": {
		text: agentWorkflowNotice,
		purpose: "recasts the user's message as a deterministic multi-agent workflow",
	},
	"agent/yield-schema-repair": {
		text: agentYieldSchemaRepair,
		purpose: "repairs an invalid structured terminal yield without discarding accepted incremental data",
	},
	"agent/yield-reminder": {
		text: agentYieldReminder,
		purpose: "forces an agent to yield when its budget or turn limit is spent",
	},
} satisfies Record<string, PromptEntry>);
