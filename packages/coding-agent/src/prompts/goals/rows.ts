/**
 * The `goals/` prompt rows: goal mode.
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

import goalsGoalBudgetLimit from "./goal-budget-limit.md" with { type: "text" };
import goalsGoalContinuation from "./goal-continuation.md" with { type: "text" };
import goalsGoalModeActive from "./goal-mode-active.md" with { type: "text" };
import goalsGoalModeContext from "./goal-mode-context.md" with { type: "text" };
import goalsGoalTodoContext from "./goal-todo-context.md" with { type: "text" };
import goalsGuidedGoalInterview from "./guided-goal-interview.md" with { type: "text" };
import goalsGuidedGoalSystem from "./guided-goal-system.md" with { type: "text" };

/** Every prompt under `src/prompts/goals/`, keyed by its id (the path under `src/prompts/`). */
export const goalsPrompts = {
	"goals/goal-budget-limit": {
		text: goalsGoalBudgetLimit,
		purpose: "tells the agent the active goal hit its token budget",
	},
	"goals/goal-continuation": {
		text: goalsGoalContinuation,
		purpose: "the hidden steer that resumes an autonomous goal",
	},
	"goals/goal-mode-active": {
		text: goalsGoalModeActive,
		purpose: "the goal-mode context block carrying objective and budget",
	},
	"goals/goal-mode-context": { text: goalsGoalModeContext, purpose: "composes the goal block with its todo block" },
	"goals/goal-todo-context": {
		text: goalsGoalTodoContext,
		purpose: "the persisted todo state a goal continuation gets instead of a user nudge",
	},
	"goals/guided-goal-interview": {
		text: goalsGuidedGoalInterview,
		purpose: "turns a setup interview transcript into one objective",
	},
	"goals/guided-goal-system": { text: goalsGuidedGoalSystem, purpose: "walks a user through defining a goal" },
} satisfies Record<string, PromptEntry>;
