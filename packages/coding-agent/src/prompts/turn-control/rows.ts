/**
 * The `turn-control/` prompt rows. Each directory owns its rows so importing one prompt doesn't reach all
 * 163 (the old single-module layout made `tools/read.ts` pay 167 modules). Invariant: every `.md` is
 * imported by exactly one row module, aggregated by `registry.ts`, nothing else imports a `.md`.
 * `test/core/prompt-registry-coverage.test.ts` pins this. DO NOT re-declare a row another module holds.
 */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import turnControlAutoContinue from "./auto-continue.md" with { type: "text" };
import turnControlEagerTask from "./eager-task.md" with { type: "text" };
import turnControlEagerTodo from "./eager-todo.md" with { type: "text" };
import turnControlEmptyStopRetry from "./empty-stop-retry.md" with { type: "text" };
import turnControlGeminiToolCallReminder from "./gemini-tool-call-reminder.md" with { type: "text" };
import turnControlInterruptedThinking from "./interrupted-thinking.md" with { type: "text" };
import turnControlManualContinue from "./manual-continue.md" with { type: "text" };
import turnControlMidRunTodoNudge from "./mid-run-todo-nudge.md" with { type: "text" };
import turnControlPrewalkChecklist from "./prewalk-checklist.md" with { type: "text" };
import turnControlPrewalkContinue from "./prewalk-continue.md" with { type: "text" };
import turnControlPrewalkPlan from "./prewalk-plan.md" with { type: "text" };
import turnControlRewindReport from "./rewind-report.md" with { type: "text" };
import turnControlThinkingLoopRedirect from "./thinking-loop-redirect.md" with { type: "text" };
import turnControlToolCallLoopRedirect from "./tool-call-loop-redirect.md" with { type: "text" };
import turnControlUltrathinkNotice from "./ultrathink-notice.md" with { type: "text" };
import turnControlUnexpectedStopClassifier from "./unexpected-stop-classifier.md" with { type: "text" };
import turnControlUnexpectedStopRetry from "./unexpected-stop-retry.md" with { type: "text" };

/** Every prompt under `src/prompts/turn-control/`, keyed by its id (the path under `src/prompts/`). */
export const turnControlPrompts = definePromptRows({
	"turn-control/auto-continue": {
		text: turnControlAutoContinue,
		purpose: "resumes the user's most recent intent after compaction",
	},
	"turn-control/eager-task": {
		text: turnControlEagerTask,
		purpose: "the delegation block telling the agent subagents are the default",
	},
	"turn-control/eager-todo": { text: turnControlEagerTodo, purpose: "requires a phased todo before substantive work" },
	"turn-control/empty-stop-retry": {
		text: turnControlEmptyStopRetry,
		purpose: "restarts a turn that ended without doing anything",
	},
	"turn-control/gemini-tool-call-reminder": {
		text: turnControlGeminiToolCallReminder,
		purpose: "interrupts reasoning that produced planning headers and no tool call",
	},
	"turn-control/interrupted-thinking": {
		text: turnControlInterruptedThinking,
		purpose: "hands back reasoning preserved from an interrupted turn",
	},
	"turn-control/manual-continue": { text: turnControlManualContinue, purpose: "the operator's explicit continue" },
	"turn-control/mid-run-todo-nudge": {
		text: turnControlMidRunTodoNudge,
		purpose: "reminds the agent that todo items are still open",
	},
	"turn-control/prewalk-checklist": {
		text: turnControlPrewalkChecklist,
		purpose: "the finish-line checklist before a task is called done",
	},
	"turn-control/prewalk-continue": { text: turnControlPrewalkContinue, purpose: "refuses to let the turn end here" },
	"turn-control/prewalk-plan": {
		text: turnControlPrewalkPlan,
		purpose: "demands the complete plan in the next reply",
	},
	"turn-control/rewind-report": {
		text: turnControlRewindReport,
		purpose: "replaces rewound exploration with its retained report",
	},
	"turn-control/thinking-loop-redirect": {
		text: turnControlThinkingLoopRedirect,
		purpose: "interrupts a turn whose reasoning stopped making progress",
	},
	"turn-control/tool-call-loop-redirect": {
		text: turnControlToolCallLoopRedirect,
		purpose: "interrupts repeated identical tool calls",
	},
	"turn-control/ultrathink-notice": {
		text: turnControlUltrathinkNotice,
		purpose: "raises reasoning effort for a multi-step request",
	},
	"turn-control/unexpected-stop-classifier": {
		text: turnControlUnexpectedStopClassifier,
		purpose: "decides whether an assistant turn stopped short of what it promised",
	},
	"turn-control/unexpected-stop-retry": {
		text: turnControlUnexpectedStopRetry,
		purpose: "restarts a turn that promised an action and stopped",
	},
} satisfies Record<string, PromptEntry>);
