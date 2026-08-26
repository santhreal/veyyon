/**
 * The `subagent/` prompt rows. Each directory owns its rows so importing one prompt doesn't reach all
 * 163 (the old single-module layout made `tools/read.ts` pay 167 modules). Invariant: every `.md` is
 * imported by exactly one row module, aggregated by `registry.ts`, nothing else imports a `.md`.
 * `test/core/prompt-registry-coverage.test.ts` pins this. DO NOT re-declare a row another module holds.
 */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import subagentAgentCreationArchitect from "./agent-creation-architect.md" with { type: "text" };
import subagentAgentCreationUser from "./agent-creation-user.md" with { type: "text" };
import subagentOrchestrateNotice from "./orchestrate-notice.md" with { type: "text" };
import subagentSystemPrompt from "./system-prompt.md" with { type: "text" };
import subagentTaskLabel from "./task-label.md" with { type: "text" };
import subagentUserPrompt from "./user-prompt.md" with { type: "text" };
import subagentWorkflowNotice from "./workflow-notice.md" with { type: "text" };
import subagentYieldReminder from "./yield-reminder.md" with { type: "text" };
import subagentYieldSchemaRepair from "./yield-schema-repair.md" with { type: "text" };

/** Every prompt under `src/prompts/subagent/`, keyed by its id (the path under `src/prompts/`). */
export const subagentPrompts = definePromptRows({
	"subagent/agent-creation-architect": {
		text: subagentAgentCreationArchitect,
		purpose: "designs a new agent definition from a description",
	},
	"subagent/agent-creation-user": {
		text: subagentAgentCreationUser,
		purpose: "the user half of agent creation, carrying the request",
	},
	"subagent/orchestrate-notice": {
		text: subagentOrchestrateNotice,
		purpose: "recasts the user's message as an orchestration contract",
	},
	"subagent/system-prompt": {
		text: subagentSystemPrompt,
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
	"subagent/task-label": { text: subagentTaskLabel, purpose: "labels a delegated assignment in one short sentence" },
	"subagent/user-prompt": {
		text: subagentUserPrompt,
		purpose: "the user half of a delegated task, carrying the assignment",
	},
	"subagent/workflow-notice": {
		text: subagentWorkflowNotice,
		purpose: "recasts the user's message as a deterministic multi-subagent workflow",
	},
	"subagent/yield-schema-repair": {
		text: subagentYieldSchemaRepair,
		purpose: "repairs an invalid structured terminal yield without discarding accepted incremental data",
	},
	"subagent/yield-reminder": {
		text: subagentYieldReminder,
		purpose: "forces a subagent to yield when its budget or turn limit is spent",
	},
} satisfies Record<string, PromptEntry>);
