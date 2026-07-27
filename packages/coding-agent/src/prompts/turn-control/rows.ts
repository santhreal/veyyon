/**
 * The `turn-control/` prompt rows: what starts, restarts, interrupts or pushes on an in-flight turn.
 *
 * WHY EACH DIRECTORY OWNS ITS OWN ROWS. `registry.ts` is still the ONE place that says which prompts exist,
 * and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }`
 * specifiers no longer sit in a single module. They did, and the consequence was that importing one prompt
 * statically reached all 163: `tools/read.ts` needs `PROMPTS["tools/read"]` to render its own description and
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

import type { PromptEntry } from "@veyyon/utils/prompt-registry";

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
export const turnControlPrompts = {
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
} satisfies Record<string, PromptEntry>;
