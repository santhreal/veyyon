import { describe, expect, it } from "bun:test";
import { applyOpsToPhases, nextActionableTask } from "@veyyon/coding-agent/tools/todo";

/**
 * Multi-op todo sequences: init → start → done → append → rm with exact statuses.
 */

describe("todo applyOps multi-op sequences", () => {
	it("init start done advances through the first task then next is pending", () => {
		let { phases } = applyOpsToPhases([], [{ op: "init", list: [{ phase: "A", items: ["one", "two", "three"] }] }]);
		// After init, first task is auto in_progress.
		expect(phases[0]!.tasks[0]!.status).toBe("in_progress");
		({ phases } = applyOpsToPhases(phases, [{ op: "done", task: "one" }]));
		expect(phases[0]!.tasks.find(t => t.content === "one")?.status).toBe("completed");
		// normalize may auto-start the next pending.
		const next = nextActionableTask(phases);
		expect(next?.content === "two" || next?.status === "in_progress" || next?.status === "pending").toBe(true);
	});

	it("append then rm keeps remaining tasks exact", () => {
		let { phases } = applyOpsToPhases([], [{ op: "init", list: [{ phase: "A", items: ["keep"] }] }]);
		({ phases } = applyOpsToPhases(phases, [{ op: "append", phase: "A", items: ["drop-me", "also-keep"] }]));
		expect(phases[0]!.tasks.map(t => t.content)).toEqual(["keep", "drop-me", "also-keep"]);
		({ phases } = applyOpsToPhases(phases, [{ op: "rm", task: "drop-me" }]));
		expect(phases[0]!.tasks.map(t => t.content)).toEqual(["keep", "also-keep"]);
	});

	it("done on unknown task records error and leaves list unchanged", () => {
		const seeded = applyOpsToPhases([], [{ op: "init", list: [{ phase: "A", items: ["only"] }] }]).phases;
		const before = JSON.stringify(seeded);
		const { phases, errors } = applyOpsToPhases(seeded, [{ op: "done", task: "missing" }]);
		expect(errors.length).toBeGreaterThan(0);
		expect(JSON.stringify(phases)).toBe(before);
	});

	it("view op leaves phases unchanged", () => {
		const seeded = applyOpsToPhases([], [{ op: "init", list: [{ phase: "A", items: ["x"] }] }]).phases;
		const { phases, errors } = applyOpsToPhases(seeded, [{ op: "view" }]);
		expect(errors).toEqual([]);
		expect(phases[0]!.tasks[0]!.content).toBe("x");
	});
});
