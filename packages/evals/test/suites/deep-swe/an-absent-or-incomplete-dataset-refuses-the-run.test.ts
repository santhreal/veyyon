/**
 * WHY THIS SUITE EXISTS:
 *
 * DeepSWE evaluation runs consist of thousands of trials. If preflight passes when
 * the dataset corpus is absent or incomplete, thousands of container trials would launch
 * and fail one by one with uninformative container errors.
 *
 * This suite enforces that:
 * 1. DeepSWE preflight fails closed when the task corpus directory is absent, naming
 *    the missing path and the command to clone it.
 * 2. DeepSWE preflight fails closed when a task list names tasks not present in the corpus,
 *    naming the missing IDs and the count.
 * 3. DeepSWE preflight passes when given a valid fixture corpus with matching tasks.
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * Runtime network drops during containerized task execution.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { internalScratchDir } from "../../../engine/package-paths";
import { deepSweSuite } from "../../../suites/deep-swe/main";

function createScratchDir(prefix: string): string {
	const base = internalScratchDir();
	fs.mkdirSync(base, { recursive: true });
	return fs.mkdtempSync(path.join(base, prefix));
}

function createFixtureCorpus(
	rootDir: string,
	tasks: Array<{ id: string; timeBudgetSec?: number }>,
): { corpusDir: string; taskListFile: string } {
	const corpusDir = path.join(rootDir, "corpus");
	fs.mkdirSync(corpusDir, { recursive: true });

	const taskListLines: string[] = [];
	for (const task of tasks) {
		taskListLines.push(task.id);
		const taskDir = path.join(corpusDir, task.id);
		fs.mkdirSync(taskDir, { recursive: true });
		fs.writeFileSync(
			path.join(taskDir, "task.toml"),
			`[agent]\ntimeout_sec = ${task.timeBudgetSec ?? 1800}\n`,
			"utf8",
		);
	}
	const taskListFile = path.join(rootDir, "tasks.txt");
	fs.writeFileSync(taskListFile, `${taskListLines.join("\n")}\n`, "utf8");

	return { corpusDir, taskListFile };
}

describe("DeepSWE Preflight — fail closed on absent or incomplete dataset", () => {
	it("refuses with a named path and clone command when corpus directory is missing", async () => {
		const scratch = createScratchDir("deepswe-corpus-missing-");
		try {
			const nonexistentCorpus = path.join(scratch, "nonexistent-corpus");
			const verdict = await deepSweSuite.preflight({
				datasetDir: nonexistentCorpus,
				options: {},
			});

			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toBeDefined();
			expect(verdict.reason).toContain(nonexistentCorpus);
			expect(verdict.reason).toContain("git clone");
			expect(verdict.reason).toContain("datasets/deep-swe/corpus");
			expect(verdict.missingRequirements).toBeDefined();
			expect(verdict.missingRequirements).toContain("task-corpus");
		} finally {
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("refuses when task list names tasks absent from the corpus, naming count and missing ids", async () => {
		const scratch = createScratchDir("deepswe-partial-corpus-");
		try {
			// Corpus has task-a and task-b
			const { corpusDir } = createFixtureCorpus(scratch, [{ id: "task-a" }, { id: "task-b" }]);

			// Task list names task-a, task-missing-1, task-missing-2, task-missing-3
			const taskListFile = path.join(scratch, "named-tasks.txt");
			fs.writeFileSync(
				taskListFile,
				`${["task-a", "task-missing-1", "task-missing-2", "task-missing-3"].join("\n")}\n`,
				"utf8",
			);

			const verdict = await deepSweSuite.preflight({
				datasetDir: corpusDir,
				options: {
					tasksFile: taskListFile,
				},
			});

			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toBeDefined();
			expect(verdict.reason).toContain("missing 3 task(s)");
			expect(verdict.reason).toContain("task-missing-1");
			expect(verdict.reason).toContain("task-missing-2");
			expect(verdict.reason).toContain("task-missing-3");
			expect(verdict.missingRequirements).toContain("task-corpus-tasks");
		} finally {
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("refuses when an explicitly passed task list file is missing", async () => {
		const scratch = createScratchDir("deepswe-tasklist-missing-");
		try {
			const { corpusDir } = createFixtureCorpus(scratch, [{ id: "task-1" }]);
			const missingTaskList = path.join(scratch, "nonexistent-tasks.txt");

			const verdict = await deepSweSuite.preflight({
				datasetDir: corpusDir,
				options: {
					tasksFile: missingTaskList,
				},
			});

			expect(verdict.ok).toBe(false);
			expect(verdict.reason).toBeDefined();
			expect(verdict.reason).toContain("missing");
			expect(verdict.reason).toContain(missingTaskList);
			expect(verdict.missingRequirements).toContain("task-list-file");
		} finally {
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("passes preflight when valid fixture corpus and task list are present", async () => {
		const scratch = createScratchDir("deepswe-corpus-valid-");
		try {
			const { corpusDir, taskListFile } = createFixtureCorpus(scratch, [
				{ id: "fixture-task-1", timeBudgetSec: 600 },
				{ id: "fixture-task-2", timeBudgetSec: 900 },
			]);

			const verdict = await deepSweSuite.preflight({
				datasetDir: corpusDir,
				options: {
					tasksFile: taskListFile,
				},
			});

			expect(verdict.ok).toBe(true);
			expect(verdict.reason).toBeUndefined();
		} finally {
			fs.rmSync(scratch, { recursive: true, force: true });
		}
	});
});
