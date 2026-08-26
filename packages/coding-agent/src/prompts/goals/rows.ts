/**
 * The `goals/` prompt rows. Each directory owns its rows so importing one prompt doesn't reach all
 * 163 (the old single-module layout made `tools/read.ts` pay 167 modules). Invariant: every `.md` is
 * imported by exactly one row module, aggregated by `registry.ts`, nothing else imports a `.md`.
 * `test/core/prompt-registry-coverage.test.ts` pins this. DO NOT re-declare a row another module holds.
 */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import goalsGoalBudgetLimit from "./goal-budget-limit.md" with { type: "text" };
import goalsGoalContinuation from "./goal-continuation.md" with { type: "text" };
import goalsGoalModeActive from "./goal-mode-active.md" with { type: "text" };
import goalsGoalModeContext from "./goal-mode-context.md" with { type: "text" };
import goalsGoalTodoContext from "./goal-todo-context.md" with { type: "text" };
import goalsGuidedGoalInterview from "./guided-goal-interview.md" with { type: "text" };
import goalsGuidedGoalSystem from "./guided-goal-system.md" with { type: "text" };

/** Every prompt under `src/prompts/goals/`, keyed by its id (the path under `src/prompts/`). */
export const goalsPrompts = definePromptRows({
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
} satisfies Record<string, PromptEntry>);
