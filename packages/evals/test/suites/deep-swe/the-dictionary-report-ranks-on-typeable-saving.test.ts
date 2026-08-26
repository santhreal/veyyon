/**
 * WHY: `dicts/report.md` is the instrument task selection reads, and ranking it on the
 * SDK's raw savings estimate once picked a task whose true ceiling was 0.27% of output
 * against 8.15% token noise — an experiment that could not have produced a result. The
 * ranking, the columns and the scaled expected-saving figure lived inside the
 * generator's `main()`, unreachable without cloning a hundred repositories, so nothing
 * held the ranking key in place.
 *
 * The class this closes: a report that ranks on a column other than typeable saving, or
 * that drops a task whose generation failed. The renderer is exported and driven
 * directly, and the expected-saving column is checked against the emission rate the
 * aggregate module owns, so scaling the wrong column turns this red.
 *
 * What it does not catch: whether the SDK's handle counts are right (that is argot's
 * contract), whether a repository checkout matches its recorded base commit, and the
 * prose of the report's preamble.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@veyyon/utils";
import { OBSERVED_TYPEABLE_EMISSION_RATE } from "../../../src/suites/deep-swe/aggregate";
import { type DictRow, renderDictReport, taskRepoInfo } from "../../../src/suites/deep-swe/gen-dicts";

function row(task: string, overrides: Partial<DictRow> = {}): DictRow {
	return {
		task,
		handles: 40,
		dictTokens: 900,
		estimatedSavings: 300,
		typeableHandles: 4,
		structureHandles: 36,
		typeableSavings: 100,
		expectedSavings: Math.round(100 * OBSERVED_TYPEABLE_EMISSION_RATE),
		repoUrl: "https://example.invalid/repo",
		baseCommit: "0123456789abcdef",
		error: null,
		...overrides,
	};
}

/** Data rows of the savings table, which ends where the revisions section begins. */
function tableRows(report: string): string[] {
	return report
		.slice(0, report.indexOf("## Source revisions"))
		.split("\n")
		.filter(line => line.startsWith("| ") && !line.startsWith("| task ") && !line.startsWith("|---"));
}

describe("ranking the dictionary report", () => {
	it("orders tasks by typeable saving, not by the raw SDK estimate", () => {
		const report = renderDictReport(
			[
				row("low-typeable", { typeableSavings: 10, estimatedSavings: 9_000 }),
				row("high-typeable", { typeableSavings: 400, estimatedSavings: 12 }),
				row("mid-typeable", { typeableSavings: 120, estimatedSavings: 4_000 }),
			],
			"2026-01-01T00:00:00.000Z",
		);

		expect(tableRows(report).map(line => line.split(" | ")[0])).toEqual([
			"| high-typeable",
			"| mid-typeable",
			"| low-typeable",
		]);
	});

	it("leaves the caller's rows in their original order", () => {
		const rows = [row("b", { typeableSavings: 1 }), row("a", { typeableSavings: 2 })];
		renderDictReport(rows, "2026-01-01T00:00:00.000Z");

		expect(rows.map(entry => entry.task)).toEqual(["b", "a"]);
	});

	it("keeps a failed task in the table as an error row rather than dropping it", () => {
		const report = renderDictReport([row("ok"), row("broken", { error: "clone failed: 128" })], "when");
		const rows = tableRows(report);

		expect(rows).toHaveLength(2);
		expect(rows.some(line => line.includes("| ERROR: clone failed: 128 |"))).toBe(true);
		expect(rows.find(line => line.startsWith("| broken"))).toContain("| — | — | — |");
	});

	it("prints every measured column of a task in the declared column order", () => {
		const report = renderDictReport(
			[
				row("one", {
					handles: 43,
					structureHandles: 41,
					typeableHandles: 2,
					typeableSavings: 88,
					expectedSavings: 1,
					dictTokens: 1_024,
					estimatedSavings: 512,
				}),
			],
			"when",
		);

		expect(tableRows(report)[0]).toBe("| one | 43 | 41 | 2 | 88 | 1 | 1024 | 512 |");
		expect(report).toContain(
			"| task | handles | structure | typeable handles | typeable saving (ch/emission) | expected saving (ch/emission) | dict tokens | raw SDK estimate (output tok) |",
		);
	});

	it("states the generation timestamp it was given rather than the current clock", () => {
		expect(renderDictReport([], "2026-02-03T04:05:06.000Z")).toContain(
			"Generated 2026-02-03T04:05:06.000Z by gen-dicts.ts",
		);
	});

	it("states the measured emission rate the expected-saving column is scaled by", () => {
		expect(renderDictReport([], "when")).toContain(`(${(100 * OBSERVED_TYPEABLE_EMISSION_RATE).toFixed(2)}%)`);
	});
});

describe("the revision each dictionary was measured against", () => {
	it("states the repository and base commit of every task in the table", () => {
		const report = renderDictReport(
			[
				row("first", { repoUrl: "https://example.invalid/one", baseCommit: "aaa111" }),
				row("second", { typeableSavings: 5, repoUrl: "https://example.invalid/two", baseCommit: "bbb222" }),
			],
			"when",
		);

		const section = report.slice(report.indexOf("## Source revisions"));
		expect(section).toContain("| first | https://example.invalid/one | aaa111 |");
		expect(section).toContain("| second | https://example.invalid/two | bbb222 |");
	});

	it("marks a task whose revision was never recorded rather than omitting the row", () => {
		const section = renderDictReport(
			[row("unknown-source", { repoUrl: null, baseCommit: null, error: "clone failed: 128" })],
			"when",
		);

		expect(section.slice(section.indexOf("## Source revisions"))).toContain("| unknown-source | — | — |");
	});

	it("lists revisions in the same ranked order as the savings table", () => {
		const report = renderDictReport(
			[
				row("slow", { typeableSavings: 1, baseCommit: "slow-sha" }),
				row("fast", { typeableSavings: 900, baseCommit: "fast-sha" }),
			],
			"when",
		);
		const section = report.slice(report.indexOf("## Source revisions"));

		expect(section.indexOf("fast-sha")).toBeLessThan(section.indexOf("slow-sha"));
	});
});

describe("reading a task's source repository", () => {
	it("returns the repository url and base commit a task declares", async () => {
		await using temp = await TempDir.create("gen-dicts-task-");
		const taskDir = path.join(temp.path(), "some-task");
		await fs.mkdir(taskDir, { recursive: true });
		await fs.writeFile(
			path.join(taskDir, "task.toml"),
			['repository_url = "https://example.invalid/repo"', 'base_commit_hash = "abc123"', ""].join("\n"),
		);

		expect(taskRepoInfo("some-task", temp.path())).toEqual({
			url: "https://example.invalid/repo",
			sha: "abc123",
		});
	});

	it("refuses a task whose toml states no commit, naming the task", async () => {
		await using temp = await TempDir.create("gen-dicts-task-");
		const taskDir = path.join(temp.path(), "half-declared");
		await fs.mkdir(taskDir, { recursive: true });
		await fs.writeFile(path.join(taskDir, "task.toml"), 'repository_url = "https://example.invalid/repo"\n');

		expect(() => taskRepoInfo("half-declared", temp.path())).toThrow(
			/task\.toml missing repository_url\/base_commit_hash: half-declared/,
		);
	});
});
