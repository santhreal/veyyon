import { Settings } from "@veyyon/coding-agent/config/settings";
import { GoalTool } from "@veyyon/coding-agent/goals/tools/goal-tool";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { errorMessage } from "@veyyon/utils";
import { type FlagGrammar, parseFlags } from "../engine/flag-grammar";

export interface GoalBudgetContextMeasurement {
	enabled: boolean;
	descriptionBytes: number;
	schemaBytes: number;
	totalBytes: number;
	schemaProperties: string[];
}

/** Measure the exact model-facing goal tool payload for one budget setting state. */
export function measureGoalBudgetContext(enabled: boolean): GoalBudgetContextMeasurement {
	const settings = Settings.isolated({ "goal.modelBudgetsEnabled": enabled });
	const tool = new GoalTool({ settings } as ToolSession);
	const descriptionBytes = Buffer.byteLength(tool.description, "utf8");
	const schema = tool.parameters.toJsonSchema() as { properties?: Record<string, unknown> };
	const schemaBytes = Buffer.byteLength(JSON.stringify(schema), "utf8");
	return {
		enabled,
		descriptionBytes,
		schemaBytes,
		totalBytes: descriptionBytes + schemaBytes,
		schemaProperties: Object.keys(schema.properties ?? {}).sort(),
	};
}

/** Run the paired, same-input context benchmark with the default-off arm first. */
export function runGoalBudgetContextBench(): {
	off: GoalBudgetContextMeasurement;
	on: GoalBudgetContextMeasurement;
	deltaBytes: number;
} {
	const off = measureGoalBudgetContext(false);
	const on = measureGoalBudgetContext(true);
	return { off, on, deltaBytes: on.totalBytes - off.totalBytes };
}

/**
 * This bench measures both arms of one setting and takes no input. It declares that, so a flag
 * meant for another bench refuses here instead of being dropped and reported as a measurement of
 * whatever the caller asked to change.
 */
export const GOAL_BUDGET_CONTEXT_FLAGS = {
	valued: {},
	valueless: { help: true },
} as const satisfies FlagGrammar;

const GOAL_BUDGET_CONTEXT_USAGE =
	"usage: bun goal-budget-context-bench.ts    (measures the goal tool payload with budgets off and on)\n";

if (import.meta.main) {
	let flags: Record<string, string>;
	try {
		flags = parseFlags(process.argv.slice(2), GOAL_BUDGET_CONTEXT_FLAGS);
	} catch (error) {
		console.error(errorMessage(error));
		console.error(GOAL_BUDGET_CONTEXT_USAGE);
		process.exit(2);
	}
	if (flags.help !== undefined) {
		process.stdout.write(GOAL_BUDGET_CONTEXT_USAGE);
	} else {
		process.stdout.write(`${JSON.stringify(runGoalBudgetContextBench(), null, 2)}\n`);
	}
}
