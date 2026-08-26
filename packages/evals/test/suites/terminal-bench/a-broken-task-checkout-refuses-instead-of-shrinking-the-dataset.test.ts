/**
 * WHY: task discovery wrapped each entry of the dataset's `tasks/` directory in one bare `catch {}`,
 * so a directory it could not read was indistinguishable from a directory that is not a task. A
 * checkout with an unreadable task, or a `task.toml` that is not a file, silently produced a shorter
 * task list — and that list is what the run executes AND what `computeTaskSetContentHash` hashes, so
 * a partial dataset was recorded as the whole one, with a provenance hash that agreed with itself.
 *
 * The class this closes: a discovery pass that reports a read failure as an absent member. Every
 * state one entry of `tasks/` can be in is swept — a task, a plain file, a directory with no config,
 * a config that is a directory, an entry that cannot be read at all — against whether it is counted,
 * skipped or refused. The empty result is refused too, because a dataset with no task cannot be run
 * and its content hash would otherwise certify an empty corpus.
 *
 * WHAT THIS DOES NOT CATCH: whether a discovered `task.toml` parses, or describes a runnable task —
 * `suite.describeTask` reads it and has its own suite. The unreadable-entry case needs a mode change
 * to stage, so it is skipped where the test process can read everything regardless (as root).
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverTerminalBenchTasks } from "../../../src/suites/terminal-bench/dataset";
import { computeTaskSetContentHash } from "../../../src/suites/terminal-bench/provenance";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function datasetRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-discovery-"));
	cleanups.push(() => {
		fs.chmodSync(dir, 0o755);
		for (const entry of fs.readdirSync(path.join(dir, "tasks"), { withFileTypes: true })) {
			if (entry.isDirectory()) fs.chmodSync(path.join(dir, "tasks", entry.name), 0o755);
		}
		fs.rmSync(dir, { recursive: true, force: true });
	});
	fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
	return dir;
}

function writeTask(root: string, name: string): void {
	const dir = path.join(root, "tasks", name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "task.toml"), `[task]\nname = "${name}"\n`);
	fs.writeFileSync(path.join(dir, "instruction.md"), `do ${name}\n`);
}

describe("a broken task checkout refuses instead of shrinking the dataset", () => {
	it("counts every task directory that carries a config, in sorted order", async () => {
		const root = datasetRoot();
		writeTask(root, "zeta");
		writeTask(root, "alpha");

		expect(await discoverTerminalBenchTasks(root)).toEqual(["alpha", "zeta"]);
	});

	it("skips what is plainly not a task: a loose file and a directory with no config", async () => {
		const root = datasetRoot();
		writeTask(root, "alpha");
		fs.writeFileSync(path.join(root, "tasks", "README.md"), "not a task\n");
		fs.mkdirSync(path.join(root, "tasks", "scratch"), { recursive: true });

		expect(await discoverTerminalBenchTasks(root)).toEqual(["alpha"]);
	});

	it("refuses a task config that is a directory instead of dropping the task", async () => {
		const root = datasetRoot();
		writeTask(root, "alpha");
		fs.mkdirSync(path.join(root, "tasks", "broken", "task.toml"), { recursive: true });

		await expect(discoverTerminalBenchTasks(root)).rejects.toThrow(/task config .*broken\/task\.toml" is not a file/);
	});

	it("refuses an entry it cannot read rather than reporting one task fewer", async () => {
		const root = datasetRoot();
		writeTask(root, "alpha");
		writeTask(root, "sealed");
		fs.chmodSync(path.join(root, "tasks", "sealed"), 0o000);
		if (fs.existsSync(path.join(root, "tasks", "sealed", "task.toml"))) {
			// The process can read through the mode bits, so the state cannot be staged here.
			return;
		}

		await expect(discoverTerminalBenchTasks(root)).rejects.toThrow(/Cannot read Terminal-Bench task config/);
	});

	it("refuses a tasks directory holding no task at all", async () => {
		const root = datasetRoot();
		fs.writeFileSync(path.join(root, "tasks", "notes.txt"), "nothing here\n");

		await expect(discoverTerminalBenchTasks(root)).rejects.toThrow(/holds no task under/);
	});

	it("refuses a dataset with no tasks directory, naming the directory it could not read", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "tb-discovery-empty-"));
		cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

		await expect(discoverTerminalBenchTasks(root)).rejects.toThrow(/Failed to read Terminal-Bench tasks directory/);
	});

	it("hashes the task set it discovered, and a dropped task would change that hash", async () => {
		const root = datasetRoot();
		writeTask(root, "alpha");
		writeTask(root, "beta");

		const both = await computeTaskSetContentHash(root, await discoverTerminalBenchTasks(root));
		const one = await computeTaskSetContentHash(root, ["alpha"]);

		expect(both).not.toBe(one);
		expect(both).toMatch(/^[0-9a-f]{64}$/);
	});
});
