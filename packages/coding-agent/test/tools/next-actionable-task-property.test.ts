import { describe, expect, it } from "bun:test";
import { nextActionableTask, type TodoPhase } from "@veyyon/coding-agent/tools/todo";

/**
 * nextActionableTask selection over many phase layouts.
 */

describe("nextActionableTask property-style", () => {
	it("always prefers the first in_progress when present", () => {
		for (let n = 1; n <= 10; n++) {
			const phases: TodoPhase[] = [
				{
					name: "A",
					tasks: Array.from({ length: n }, (_, i) => ({
						content: `t${i}`,
						status: i === Math.floor(n / 2) ? ("in_progress" as const) : ("pending" as const),
					})),
				},
			];
			const task = nextActionableTask(phases);
			expect(task?.status).toBe("in_progress");
			expect(task?.content).toBe(`t${Math.floor(n / 2)}`);
		}
	});

	it("returns first pending when no in_progress", () => {
		const phases: TodoPhase[] = [
			{
				name: "A",
				tasks: [
					{ content: "done", status: "completed" },
					{ content: "next", status: "pending" },
					{ content: "later", status: "pending" },
				],
			},
		];
		expect(nextActionableTask(phases)?.content).toBe("next");
	});

	it("returns undefined when only completed/abandoned", () => {
		const phases: TodoPhase[] = [
			{
				name: "A",
				tasks: [
					{ content: "a", status: "completed" },
					{ content: "b", status: "abandoned" },
				],
			},
		];
		expect(nextActionableTask(phases)).toBeUndefined();
	});

	it("searches later phases when the first is empty of actionable work", () => {
		const phases: TodoPhase[] = [
			{ name: "A", tasks: [{ content: "done", status: "completed" }] },
			{ name: "B", tasks: [{ content: "work", status: "pending" }] },
		];
		expect(nextActionableTask(phases)?.content).toBe("work");
	});
});
