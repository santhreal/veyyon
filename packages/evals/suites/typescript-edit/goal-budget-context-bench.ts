import { Settings } from "@veyyon/coding-agent/config/settings";
import { GoalTool } from "@veyyon/coding-agent/goals/tools/goal-tool";
import type { ToolSession } from "@veyyon/coding-agent/tools";

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

if (import.meta.main) {
	process.stdout.write(`${JSON.stringify(runGoalBudgetContextBench(), null, 2)}\n`);
}
