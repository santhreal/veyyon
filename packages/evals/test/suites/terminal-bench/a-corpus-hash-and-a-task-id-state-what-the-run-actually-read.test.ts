/**
 * WHY: three fields of a Terminal-Bench run described a corpus nobody had read.
 *
 *  - `computeTaskSetContentHash` caught a failed `readFile` and hashed the empty buffer, so a task
 *    whose `task.toml` was missing hashed identically to one whose `task.toml` was empty. A
 *    half-checked-out dataset therefore produced a plausible content hash, and that hash was
 *    recorded as the provenance two runs are compared by.
 *  - `computeTerminalBenchProvenance` caught a failed `git rev-parse` and substituted the pinned
 *    constant, so `resolvedCommitSha` reported the commit the checkout was supposed to be at. That
 *    is the one field of the record a later reader cannot verify for themselves.
 *  - a task id comes from a task list file, which is data, and went straight into
 *    `path.join(datasetRoot, "tasks", taskId)`. A line reading `../../../etc` addressed a directory
 *    outside the corpus, and the run reported it as a task.
 *
 * The class this closes is a provenance field that states something other than what was read, and a
 * data-sourced name that becomes a path without passing the validator. The path-builder sweep reads
 * the dataset module's exports at run time, so a new `getTerminalBenchTask*Path` helper joins it the
 * moment it exists and turns this suite red until it validates its id.
 *
 * What it does not catch: whether the pinned commit is the right one, whether a task's content is
 * meaningful, and a caller that builds a task path with `path.join` by hand instead of using these
 * helpers.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import * as dataset from "../../../src/suites/terminal-bench/dataset";
import {
	computeTaskSetContentHash,
	computeTerminalBenchProvenance,
} from "../../../src/suites/terminal-bench/provenance";
import { parseTaskList } from "../../../src/suites/terminal-bench/task-list";

const temps: TempDir[] = [];

afterEach(async () => {
	while (temps.length > 0) await temps.pop()?.remove();
});

async function corpus(tasks: Record<string, { toml?: string; instruction?: string }>): Promise<string> {
	const temp = await TempDir.create("terminal-bench-corpus");
	temps.push(temp);
	const root = temp.absolute();
	for (const [id, files] of Object.entries(tasks)) {
		const dir = path.join(root, "tasks", id);
		await mkdir(dir, { recursive: true });
		if (files.toml !== undefined) await writeFile(path.join(dir, "task.toml"), files.toml);
		if (files.instruction !== undefined) await writeFile(path.join(dir, "instruction.md"), files.instruction);
	}
	return root;
}

/** Every helper that turns a task id into a path, read off the module rather than listed here. */
const PATH_BUILDERS = Object.entries(dataset)
	.filter(([name, value]) => name.startsWith("getTerminalBenchTask") && typeof value === "function")
	.map(
		([name, value]) =>
			[name, value as (root: string, taskId: string) => string] as [
				string,
				(root: string, taskId: string) => string,
			],
	);

const HOSTILE_IDS: readonly string[] = ["..", ".", "../escape", "a/b", "a\\b", "", " leading", "/absolute"];

describe("a corpus content hash", () => {
	it("refuses a task whose config it could not read, naming the file", async () => {
		const root = await corpus({ present: { toml: "x = 1", instruction: "do it" }, broken: { instruction: "do it" } });

		await expect(computeTaskSetContentHash(root, ["present", "broken"])).rejects.toThrow(
			/Cannot hash Terminal-Bench task "broken"/,
		);
		await expect(computeTaskSetContentHash(root, ["present", "broken"])).rejects.toThrow(/task\.toml/);
	});

	it("refuses a task whose instruction it could not read", async () => {
		const root = await corpus({ broken: { toml: "x = 1" } });

		await expect(computeTaskSetContentHash(root, ["broken"])).rejects.toThrow(/instruction\.md/);
	});

	it("distinguishes an empty file from an unreadable one", async () => {
		const empty = await corpus({ t: { toml: "", instruction: "" } });
		const missing = await corpus({ t: { instruction: "" } });

		// Before the fix both sides produced this same digest.
		expect(await computeTaskSetContentHash(empty, ["t"])).toMatch(/^[0-9a-f]{64}$/);
		await expect(computeTaskSetContentHash(missing, ["t"])).rejects.toThrow(/Cannot hash/);
	});

	it("covers the content, not the order the tasks were named in", async () => {
		const root = await corpus({ a: { toml: "a", instruction: "A" }, b: { toml: "b", instruction: "B" } });

		const forward = await computeTaskSetContentHash(root, ["a", "b"]);
		const reverse = await computeTaskSetContentHash(root, ["b", "a"]);
		expect(forward).toBe(reverse);

		const changed = await corpus({ a: { toml: "a", instruction: "A" }, b: { toml: "b!", instruction: "B" } });
		expect(await computeTaskSetContentHash(changed, ["a", "b"])).not.toBe(forward);
	});

	it("covers a subset only, so a selected task set hashes to its own value", async () => {
		const root = await corpus({ a: { toml: "a", instruction: "A" }, b: { toml: "b", instruction: "B" } });

		expect(await computeTaskSetContentHash(root, ["a"])).not.toBe(await computeTaskSetContentHash(root, ["a", "b"]));
	});
});

describe("the commit a run records", () => {
	it("refuses to name one when the checkout cannot be resolved", async () => {
		const root = await corpus({ a: { toml: "a", instruction: "A" } });

		// Not a git checkout, so `git rev-parse HEAD` has nothing to answer with.
		await expect(computeTerminalBenchProvenance({ datasetRoot: root })).rejects.toThrow(
			/Cannot resolve the commit of the Terminal-Bench checkout/,
		);
	});

	it("records the commit it was handed, with the tasks it hashed", async () => {
		const root = await corpus({ a: { toml: "a", instruction: "A" }, b: { toml: "b", instruction: "B" } });

		const provenance = await computeTerminalBenchProvenance({
			datasetRoot: root,
			commitSha: "0".repeat(40),
			timestamp: "2025-01-01T00:00:00.000Z",
		});

		expect(provenance.resolvedCommitSha).toBe("0".repeat(40));
		expect(provenance.selectedTasks).toEqual(["a", "b"]);
		expect(provenance.taskCount).toBe(2);
		expect(provenance.contentHash).toBe(await computeTaskSetContentHash(root, ["a", "b"]));
		expect(provenance.timestamp).toBe("2025-01-01T00:00:00.000Z");
	});
});

describe("a task id that came out of a task list", () => {
	it("is one path segment, or the list refuses by line number", () => {
		expect(() => parseTaskList("# @headline: set\nfine-task\n../../../etc\n", "sets/demo.txt")).toThrow(
			/sets\/demo\.txt line 3/,
		);
		expect(() => parseTaskList("a\nb/c\n")).toThrow(/task list line 2/);
	});

	it("still parses a list of real names, with its provenance", () => {
		const parsed = parseTaskList("# @biased: smoke\n\nalpha\n  beta  \n# trailing\ngamma\n");

		expect(parsed.tasks).toEqual(["alpha", "beta", "gamma"]);
		expect(parsed.provenance).toEqual({ marked: true, biased: true, note: "smoke" });
	});

	it("cannot escape the dataset root through any path helper the module exports", () => {
		expect(PATH_BUILDERS.length).toBeGreaterThanOrEqual(3);

		for (const [name, build] of PATH_BUILDERS) {
			for (const hostile of HOSTILE_IDS) {
				let thrown: unknown = null;
				try {
					build("/datasets/tb", hostile);
				} catch (error) {
					thrown = error;
				}
				expect(thrown, `${name} accepted ${JSON.stringify(hostile)}`).not.toBeNull();
			}
			expect(build("/datasets/tb", "real-task").startsWith(path.join("/datasets/tb", "tasks", "real-task"))).toBe(
				true,
			);
		}
	});
});
