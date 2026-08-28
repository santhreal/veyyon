/**
 * WHY: When a Harbor trial crashes mid-write or encounters unexpected I/O,
 * result.json can be truncated, malformed, or missing verifier output. The trial
 * parser must handle incomplete files gracefully without throwing, and classify
 * error states accurately.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseTrial, readJobResult } from "../../../backends/harbor/results";

describe("a trial parser handles truncated and partial results", () => {
	let jobDir: string;

	beforeEach(() => {
		jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "trial-parser-test-"));
	});

	afterEach(() => {
		fs.rmSync(jobDir, { recursive: true, force: true });
	});

	it("returns null on a truncated or unparsable result.json in a trial dir", () => {
		const trialDir = path.join(jobDir, "task_1__abc1234");
		fs.mkdirSync(trialDir, { recursive: true });
		fs.writeFileSync(path.join(trialDir, "result.json"), '{"agent_result": {"cost_usd": 0.05'); // truncated JSON

		const trial = parseTrial(trialDir, "task_1__abc1234");
		expect(trial).toBeNull();
	});

	it("classifies missing or null rewards as an error with detail message", () => {
		const trialDir = path.join(jobDir, "task_2__abc1234");
		fs.mkdirSync(trialDir, { recursive: true });
		fs.writeFileSync(
			path.join(trialDir, "result.json"),
			JSON.stringify({
				agent_result: { cost_usd: 0.01, n_input_tokens: 100, n_output_tokens: 50 },
				verifier_result: null,
			}),
		);

		const trial = parseTrial(trialDir, "task_2__abc1234");
		expect(trial).not.toBeNull();
		expect(trial?.status).toBe("error");
		expect(trial?.reward).toBeNull();
		expect(trial?.detail).toBe("missing or unparsable reward");
		expect(trial?.costUsd).toBe(0.01);
		expect(trial?.tokIn).toBe(100);
	});

	it("classifies exceptions in result.json as error with the exception_type detail", () => {
		const trialDir = path.join(jobDir, "task_3__abc1234");
		fs.mkdirSync(trialDir, { recursive: true });
		fs.writeFileSync(
			path.join(trialDir, "result.json"),
			JSON.stringify({
				agent_result: { cost_usd: 0.02 },
				exception_info: { exception_type: "ContainerTimeoutError" },
			}),
		);

		const trial = parseTrial(trialDir, "task_3__abc1234");
		expect(trial).not.toBeNull();
		expect(trial?.status).toBe("error");
		expect(trial?.detail).toBe("ContainerTimeoutError");
	});

	it("classifies passing rewards >= 1 as pass", () => {
		const trialDir = path.join(jobDir, "task_4__abc1234");
		fs.mkdirSync(trialDir, { recursive: true });
		fs.writeFileSync(
			path.join(trialDir, "result.json"),
			JSON.stringify({
				verifier_result: { rewards: { accuracy: 1.0 } },
				started_at: "2026-08-26T10:00:00.000Z",
				finished_at: "2026-08-26T10:00:05.500Z",
			}),
		);

		const trial = parseTrial(trialDir, "task_4__abc1234");
		expect(trial).not.toBeNull();
		expect(trial?.status).toBe("pass");
		expect(trial?.reward).toBe(1.0);
		expect(trial?.durationMs).toBe(5500);
	});

	it("reads running state when trial directory exists without result.json", () => {
		const trialDir = path.join(jobDir, "task_5__abc1234");
		fs.mkdirSync(trialDir, { recursive: true });

		const trial = parseTrial(trialDir, "task_5__abc1234");
		expect(trial).not.toBeNull();
		expect(trial?.status).toBe("running");
		expect(trial?.reward).toBeNull();
	});

	it("parses the job-level result.json harbor writes, with incremental stats and a finish stamp", () => {
		fs.writeFileSync(
			path.join(jobDir, "result.json"),
			JSON.stringify({
				n_total_trials: 10,
				stats: {
					n_running_trials: 2,
					n_pending_trials: 3,
				},
				finished_at: "2026-08-26T12:34:56.789Z",
			}),
		);

		const jobInfo = readJobResult(jobDir);
		expect(jobInfo).not.toBeNull();
		expect(jobInfo?.nTotal).toBe(10);
		expect(jobInfo?.running).toBe(2);
		expect(jobInfo?.pending).toBe(3);
		expect(jobInfo?.finishedAt).toBe(Date.parse("2026-08-26T12:34:56.789Z"));
	});

	it("reports no job totals at all when the result states no trials, rather than a total of zero", () => {
		fs.writeFileSync(
			path.join(jobDir, "result.json"),
			JSON.stringify({ stats: { n_running_trials: 0, n_pending_trials: 0 } }),
		);
		expect(readJobResult(jobDir)).toBeNull();
	});

	it("reports a job whose trials are counted but whose stats are absent", () => {
		fs.writeFileSync(path.join(jobDir, "result.json"), JSON.stringify({ n_total_trials: 4 }));
		const jobInfo = readJobResult(jobDir);
		expect(jobInfo?.nTotal).toBe(4);
		expect(jobInfo?.running).toBeNull();
		expect(jobInfo?.pending).toBeNull();
		expect(jobInfo?.finishedAt).toBeNull();
	});
});
