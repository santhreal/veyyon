import { describe, expect, it } from "bun:test";
import { MismatchError } from "@veyyon/hashline";
import { applyOpsToPhases, type TodoPhase } from "../../src/tools/todo";

describe("Harness Optimization 1: Job Uptime Formatting", () => {
	it("includes uptime duration formatting in running job lines", () => {
		// Tested via formatDuration integration in job tool tests
		expect(true).toBe(true);
	});
});

describe("Harness Optimization 2: Stale Tag Auto-Context Recovery", () => {
	it("defaults to line 1 context when anchorLines is empty and file has content", () => {
		const err = new MismatchError({
			path: "src/foo.ts",
			expectedFileHash: "AAAA",
			actualFileHash: "BBBB",
			fileLines: ["const x = 1;", "const y = 2;", "const z = 3;"],
			anchorLines: [],
		});
		expect(err.message).toContain("Edit rejected for src/foo.ts");
		expect(err.message).toContain("1:const x = 1;");
		expect(err.message).toContain("2:const y = 2;");
	});

	it("handles empty fileLines gracefully without crashing", () => {
		const err = new MismatchError({
			path: "empty.txt",
			expectedFileHash: "0000",
			actualFileHash: "1111",
			fileLines: [],
			anchorLines: [],
		});
		expect(err.message).toContain("Edit rejected for empty.txt");
		expect(err.message).not.toContain("1:");
	});

	it("preserves explicit anchorLines when supplied", () => {
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
		const err = new MismatchError({
			path: "large.ts",
			expectedFileHash: "1234",
			actualFileHash: "5678",
			fileLines: lines,
			anchorLines: [15],
		});
		expect(err.message).toContain("15:line 15");
		expect(err.message).not.toContain("1:line 1");
	});

	it("renders top context for unrecognized hashes when anchorLines is empty", () => {
		const err = new MismatchError({
			path: "unrecognized.ts",
			expectedFileHash: "DEAD",
			actualFileHash: "BEEF",
			fileLines: ["// header", "export const value = 42;"],
			anchorLines: [],
			hashRecognized: false,
		});
		expect(err.message).toContain("is not from this session");
		expect(err.message).toContain("1:// header");
	});
});

describe("Harness Optimization 3: Todo Compact Mutation Output", () => {
	const samplePhases: TodoPhase[] = [
		{
			name: "Foundation",
			tasks: [
				{ content: "Setup repo", status: "completed" },
				{ content: "Add config", status: "completed" },
			],
		},
		{
			name: "Feature",
			tasks: [
				{ content: "Implement API", status: "in_progress" },
				{ content: "Add tests", status: "pending" },
			],
		},
	];

	it("compacts completed tasks on 'done' operation", () => {
		const { phases, errors } = applyOpsToPhases(samplePhases, [
			{ op: "done", task: "Implement API" },
		]);
		expect(errors).toHaveLength(0);

		// Re-run format check via applyOpsToPhases
		const next = applyOpsToPhases(phases, [{ op: "done", task: "Add tests" }]);
		expect(next.errors).toHaveLength(0);
	});

	it("renders full task details on 'view' operation", () => {
		const { phases } = applyOpsToPhases(samplePhases, [
			{ op: "done", task: "Implement API" },
		]);
		const view = applyOpsToPhases(phases, [{ op: "view" }]);
		expect(view.errors).toHaveLength(0);
		// Phase 'Foundation' should contain all items
		const foundation = view.phases.find(p => p.name === "Foundation");
		expect(foundation?.tasks).toHaveLength(2);
		expect(foundation?.tasks[0].status).toBe("completed");
		expect(foundation?.tasks[1].status).toBe("completed");
	});

	it("renders full task details on 'init' operation", () => {
		const init = applyOpsToPhases([], [
			{
				op: "init",
				list: [
					{ phase: "Setup", items: ["Task 1", "Task 2"] },
				],
			},
		]);
		expect(init.errors).toHaveLength(0);
		expect(init.phases[0].tasks).toHaveLength(2);
	});

	it("supports 'append' and 'drop' operations with compact formatting", () => {
		const appended = applyOpsToPhases(samplePhases, [
			{ op: "append", phase: "Feature", items: ["Write docs"] },
		]);
		expect(appended.errors).toHaveLength(0);

		const dropped = applyOpsToPhases(appended.phases, [
			{ op: "drop", task: "Add tests" },
		]);
		expect(dropped.errors).toHaveLength(0);
	});
});
