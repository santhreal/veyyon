/**
 * WHY: `report.md` is what a finished harbor run leaves for a reader — the ANSI frames scroll away.
 * The runner had a second progress loop, `runDashboardLoop`, that no caller reached any more and
 * whose tick ceiling defaulted to `Number.POSITIVE_INFINITY`; the live loop now runs under
 * `awaitHarborRun`, so that one was deleted. Its suite was the only test driving the report's
 * composition, and it asserted the loop rather than the artifact.
 *
 * The class this closes: the report is composed from what the job directory holds when it is written,
 * not from state a loop accumulated. A trial the runner never rendered still appears, a directory
 * harbor marks internal with a leading underscore is not a trial, rows are ordered by task name
 * rather than by directory order, and the summary lines carry the exit code the caller passed.
 *
 * What it does not catch: absent measurements, which
 * `an-unpriced-harbor-trial-reports-absent-spend-not-zero.test.ts` owns for both the rows and the
 * totals, and the frame `render` writes, whose formatters this file only reaches through the report.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultConfig } from "../../../backends/harbor/config";
import { type RenderState, writeReport } from "../../../backends/harbor/ui";

const AGENT = { cost_usd: 0.25, n_input_tokens: 100, n_output_tokens: 20, n_cache_tokens: 5 };

function writeTrial(jobDir: string, name: string, result: unknown): void {
	const dir = path.join(jobDir, name);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result));
}

describe("a harbor report", () => {
	let jobDir: string;
	let benchDir: string;
	let state: RenderState;

	beforeEach(() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-report-"));
		jobDir = path.join(root, "job");
		benchDir = path.join(root, "bench");
		fs.mkdirSync(jobDir, { recursive: true });
		fs.mkdirSync(benchDir, { recursive: true });
		state = {
			cfg: { ...defaultConfig(), dataset: "terminal-bench-3.0", models: ["a-model"], agent: "veyyon" },
			jobDir,
			logPath: path.join(root, "harbor.log"),
			startMs: Date.now(),
			expected: 3,
			tick: 0,
		};
	});

	afterEach(() => {
		fs.rmSync(path.dirname(jobDir), { recursive: true, force: true });
	});

	it("states every trial the job directory holds, ordered by task", () => {
		// Written in reverse: a directory listing is in the filesystem's own order, and with this many
		// entries an unsorted report cannot come out in task order by accident.
		const tasks = ["h-task", "g-task", "f-task", "e-task", "d-task", "c-task", "b-task", "a-task"];
		for (const task of tasks) {
			writeTrial(jobDir, task, { verifier_result: { rewards: { reward: 1 } }, agent_result: AGENT });
		}
		writeTrial(jobDir, "z-fail", { verifier_result: { rewards: { reward: 0 } }, agent_result: AGENT });
		writeTrial(jobDir, "_internal", { verifier_result: { rewards: { reward: 1 } }, agent_result: AGENT });

		const reportPath = writeReport(state, benchDir, 0);
		const rows = fs
			.readFileSync(reportPath, "utf8")
			.split("\n")
			.filter(line => line.startsWith("| ") && !line.startsWith("| Task") && !line.startsWith("| ---"));

		expect(reportPath).toBe(path.join(benchDir, "report.md"));
		expect(rows.map(row => row.split(" | ")[0])).toEqual([
			"| a-task",
			"| b-task",
			"| c-task",
			"| d-task",
			"| e-task",
			"| f-task",
			"| g-task",
			"| h-task",
			"| z-fail",
		]);
		expect(rows[0]).toContain("✅ pass");
		expect(rows[8]).toContain("❌ fail");
	});

	it("reports the pass rate and the exit code it was given", () => {
		writeTrial(jobDir, "one", { verifier_result: { rewards: { reward: 1 } }, agent_result: AGENT });
		writeTrial(jobDir, "two", { verifier_result: { rewards: { reward: 0 } }, agent_result: AGENT });

		const report = fs.readFileSync(writeReport(state, benchDir, 124), "utf8");

		expect(report).toContain("# Benchmark Report: terminal-bench-3.0");
		expect(report).toContain("- **Models:** a-model");
		expect(report).toContain("- **Exit Code:** 124");
		expect(report).toContain("- **Pass Rate:** 1/2 (50.0%)");
		expect(report).toContain("- **Totals:** 1 pass, 1 fail, 0 error");
		expect(report).toContain("- **Spend:** $0.50");
	});

	it("reports a job directory with no trials rather than refusing to write", () => {
		const report = fs.readFileSync(writeReport(state, benchDir, 1), "utf8");

		expect(report).toContain("- **Pass Rate:** 0/0 (0.0%)");
		expect(report).toContain("| Task | Status | Reward | Cost | Duration | Detail |");
	});
});
