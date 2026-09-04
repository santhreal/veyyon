import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDefaultTerminalBenchCacheDir } from "../../../suites/terminal-bench/dataset";
import {
	listPredefinedTaskSets,
	loadTaskList,
	parseTaskList,
	parseTaskListProvenance,
} from "../../../suites/terminal-bench/task-list";

describe("Terminal-Bench Task List Parsing & Provenance", () => {
	it("parses a @biased provenance directive with a reason", () => {
		const content = `# @biased: single task for plumbing smoke check
bun-sourcemap-leak
`;
		const prov = parseTaskListProvenance(content);
		expect(prov).toEqual({
			marked: true,
			biased: true,
			note: "single task for plumbing smoke check",
		});
	});

	it("parses a @headline provenance directive with a reason", () => {
		const content = `# @headline: representative diverse 20 tasks
bun-sourcemap-leak
html-js-filter
`;
		const prov = parseTaskListProvenance(content);
		expect(prov).toEqual({
			marked: true,
			biased: false,
			note: "representative diverse 20 tasks",
		});
	});

	it("returns marked: false when no directive is present", () => {
		const content = `# Just a generic comment without directive
bun-sourcemap-leak
`;
		const prov = parseTaskListProvenance(content);
		expect(prov).toEqual({
			marked: false,
			biased: false,
			note: null,
		});
	});

	it("ignores trailing comment directives once task list starts", () => {
		const content = `# @headline: primary headline
task-1
# @biased: sneaky trailing comment
task-2
`;
		const prov = parseTaskListProvenance(content);
		expect(prov).toEqual({
			marked: true,
			biased: false,
			note: "primary headline",
		});
	});

	it("parses task names and provenance together", () => {
		const content = `# @biased: smoke test only
bun-sourcemap-leak

# Another comment
html-js-filter
`;
		const { tasks, provenance } = parseTaskList(content);
		expect(tasks).toEqual(["bun-sourcemap-leak", "html-js-filter"]);
		expect(provenance.marked).toBe(true);
		expect(provenance.biased).toBe(true);
		expect(provenance.note).toBe("smoke test only");
	});

	it("loads committed smoke.txt task list and verifies task exists", async () => {
		const loaded = await loadTaskList("smoke");
		expect(loaded.tasks).toEqual(["bun-sourcemap-leak"]);
		expect(loaded.provenance.marked).toBe(true);
		expect(loaded.provenance.biased).toBe(true);
		expect(loaded.provenance.note).toContain("plumbing/smoke");

		const cacheDir = getDefaultTerminalBenchCacheDir();
		if (existsSync(join(cacheDir, "tasks"))) {
			const taskPath = join(cacheDir, "tasks", loaded.tasks[0]!);
			expect(existsSync(taskPath)).toBe(true);
		}
	});

	it("loads committed pilot.txt task list and verifies 10 tasks exist", async () => {
		const loaded = await loadTaskList("pilot");
		expect(loaded.tasks.length).toBe(10);
		expect(loaded.tasks).toContain("bun-sourcemap-leak");
		expect(loaded.tasks).toContain("html-js-filter");
		expect(loaded.tasks).toContain("cli-2ph-simplex");
		expect(loaded.provenance.marked).toBe(true);
		expect(loaded.provenance.biased).toBe(true);

		const cacheDir = getDefaultTerminalBenchCacheDir();
		if (existsSync(join(cacheDir, "tasks"))) {
			for (const task of loaded.tasks) {
				const taskPath = join(cacheDir, "tasks", task);
				expect(existsSync(taskPath)).toBe(true);
			}
		}
	});

	it("lists predefined task sets in the dataset directory", async () => {
		const taskSets = await listPredefinedTaskSets();
		expect(taskSets).toContain("smoke");
		expect(taskSets).toContain("pilot");
	});
});
