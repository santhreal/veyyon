/**
 * The `plan-mode/` prompt rows: the read-only plan contract and its handovers.
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

import planModeActive from "./active.md" with { type: "text" };
import planModeApproved from "./approved.md" with { type: "text" };
import planModeCompactInstructions from "./compact-instructions.md" with { type: "text" };
import planModeReference from "./reference.md" with { type: "text" };
import planModeSubagent from "./subagent.md" with { type: "text" };
import planModeToolDecisionReminder from "./tool-decision-reminder.md" with { type: "text" };
import planModeYoloHandoff from "./yolo-handoff.md" with { type: "text" };

/** Every prompt under `src/prompts/plan-mode/`, keyed by its id (the path under `src/prompts/`). */
export const planModePrompts = {
	"plan-mode/active": { text: planModeActive, purpose: "the read-only contract while plan mode is on" },
	"plan-mode/approved": { text: planModeApproved, purpose: "hands over an approved plan for execution" },
	"plan-mode/compact-instructions": {
		text: planModeCompactInstructions,
		purpose: "distills the plan-mode discussion before execution",
	},
	"plan-mode/reference": { text: planModeReference, purpose: "points a later turn back at the approved plan file" },
	"plan-mode/subagent": {
		text: planModeSubagent,
		purpose: "the prompt a subagent runs under while plan mode is active",
	},
	"plan-mode/tool-decision-reminder": {
		text: planModeToolDecisionReminder,
		purpose: "forces a next action when a plan-mode turn ended without one",
	},
	"plan-mode/yolo-handoff": {
		text: planModeYoloHandoff,
		purpose: "hands an approved plan to an agent that did not draft it",
	},
} satisfies Record<string, PromptEntry>;
