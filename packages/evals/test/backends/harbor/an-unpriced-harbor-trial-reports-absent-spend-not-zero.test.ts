/**
 * WHY: A harbor trial nobody priced used to report `$0.000` and 0 tokens. Two readers fabricated it:
 * the live cost probe started every accumulator at 0 and coerced a missing `usage.cost.total` to 0,
 * and `parseTrial` substituted `?? 0` for an absent probe and summed a `result.json` with no agent
 * context as 0. The runner's dashboard, its markdown report and the manager snapshot then all stated
 * that a run which had spent money was free.
 *
 * The class this closes: an absent measurement rendered as a measured zero, anywhere a harbor trial's
 * usage is read. Every usage field of a trial is swept, so a fifth one (reasoning tokens, say) fails
 * this suite until someone decides what it reports. Both parsers of one `result.json` — the runner's
 * and the manager's — are held to the same reading, including the status of a trial whose verifier
 * recorded no reward.
 *
 * WHAT THIS DOES NOT CATCH: the deepswe and edit snapshot readers have their own usage parsing and
 * their own suites. A probe that undercounts because it skipped a giant transcript head still reports
 * a measured number, which is the documented tradeoff of `COST_PROBE_FIRST_SCAN_BYTES`, not absence.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultConfig } from "../../../src/backends/harbor/runner/config";
import { resetCostProbes } from "../../../src/backends/harbor/runner/cost-probe";
import { aggregate, parseTrial, readTrials, type Trial } from "../../../src/backends/harbor/runner/results";
import { fmtNum, fmtUsd, type RenderState, renderTrialRow, writeReport } from "../../../src/backends/harbor/runner/ui";
import { clearBenchmarkCache, readBenchmarkSnapshot } from "../../../src/manager/benchmarks";

/** The usage fields of a trial: absent unless something measured them. */
const USAGE_KEYS = ["costUsd", "tokCache", "tokIn", "tokOut"] as const;
/** Everything else a trial carries, so the usage set is derived rather than assumed. */
const NON_USAGE_KEYS = ["detail", "durationMs", "name", "reward", "status"];

const usageEvent = (usage: Record<string, unknown>): string =>
	`${JSON.stringify({ type: "message_end", message: { role: "assistant", usage } })}\n`;

function trialOf(dir: string, name: string): Trial {
	const trial = parseTrial(dir, name);
	if (!trial) throw new Error(`no trial parsed from ${dir}`);
	return trial;
}

function usageOf(trial: Trial): Record<string, number | null> {
	return {
		costUsd: trial.costUsd,
		tokCache: trial.tokCache,
		tokIn: trial.tokIn,
		tokOut: trial.tokOut,
	};
}

describe("an unpriced harbor trial reports absent spend, not zero", () => {
	let root: string;

	beforeEach(() => {
		resetCostProbes();
		clearBenchmarkCache();
		root = fs.mkdtempSync(path.join(os.tmpdir(), "harbor-unpriced-"));
	});

	afterEach(() => {
		resetCostProbes();
		clearBenchmarkCache();
		fs.rmSync(root, { recursive: true, force: true });
	});

	function trialDir(name: string): string {
		const dir = path.join(root, name);
		fs.mkdirSync(dir, { recursive: true });
		return dir;
	}

	function writeAgentLog(dir: string, contents: string): void {
		fs.mkdirSync(path.join(dir, "agent"), { recursive: true });
		fs.writeFileSync(path.join(dir, "agent", "veyyon.txt"), contents);
	}

	describe("a running trial", () => {
		it("reports every usage field absent when it wrote no transcript, and names the fields it has", () => {
			const dir = trialDir("task_a__aaa1111");
			const trial = trialOf(dir, "task_a__aaa1111");

			expect(trial.status).toBe("running");
			// Derived from the parsed trial rather than a hardcoded list: a new usage field fails here.
			const observed = Object.keys(trial as unknown as Record<string, unknown>)
				.filter(key => !NON_USAGE_KEYS.includes(key))
				.sort();
			expect(observed).toEqual([...USAGE_KEYS]);
			expect(usageOf(trial)).toEqual({ costUsd: null, tokCache: null, tokIn: null, tokOut: null });
		});

		it("reports absent spend while the transcript holds counts from a provider that reported no price", () => {
			const dir = trialDir("task_b__bbb2222");
			writeAgentLog(dir, usageEvent({ input: 300, output: 40, cacheRead: 100 }));

			const trial = trialOf(dir, "task_b__bbb2222");
			expect(usageOf(trial)).toEqual({ costUsd: null, tokCache: 100, tokIn: 400, tokOut: 40 });
		});

		it("reports absent spend when the transcript carries a price that is not a finite number", () => {
			const dir = trialDir("task_c__ccc3333");
			writeAgentLog(dir, usageEvent({ input: 10, output: 2, cost: { total: "0.5" } }));

			const trial = trialOf(dir, "task_c__ccc3333");
			expect(trial.costUsd).toBeNull();
			expect(trial.tokIn).toBe(10);
		});

		it("keeps input tokens absent when a usage event counted only output", () => {
			const dir = trialDir("task_p__ppp6666");
			writeAgentLog(dir, usageEvent({ output: 5, cost: { total: 0.1 } }));

			const trial = trialOf(dir, "task_p__ppp6666");
			expect(trial.tokIn).toBeNull();
			expect(trial.tokCache).toBeNull();
			expect(trial.tokOut).toBe(5);
			expect(trial.costUsd).toBeCloseTo(0.1);
		});

		it("reports every field absent while the transcript holds no usage event yet", () => {
			const dir = trialDir("task_d__ddd4444");
			writeAgentLog(dir, `${JSON.stringify({ type: "message_start" })}\n`);

			expect(usageOf(trialOf(dir, "task_d__ddd4444"))).toEqual({
				costUsd: null,
				tokCache: null,
				tokIn: null,
				tokOut: null,
			});
		});

		it("still reports a measured zero as zero", () => {
			const dir = trialDir("task_e__eee5555");
			writeAgentLog(dir, usageEvent({ input: 0, output: 0, cacheRead: 0, cost: { total: 0 } }));

			expect(usageOf(trialOf(dir, "task_e__eee5555"))).toEqual({
				costUsd: 0,
				tokCache: 0,
				tokIn: 0,
				tokOut: 0,
			});
		});
	});

	describe("a finished trial", () => {
		function writeResult(name: string, result: Record<string, unknown>): string {
			const dir = trialDir(name);
			fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result));
			return dir;
		}

		const passed = { verifier_result: { rewards: { reward: 1 } } };

		it("reports absent usage when its result recorded no agent context at all", () => {
			const dir = writeResult("task_f__fff6666", passed);
			const trial = trialOf(dir, "task_f__fff6666");

			expect(trial.status).toBe("pass");
			expect(usageOf(trial)).toEqual({ costUsd: null, tokCache: null, tokIn: null, tokOut: null });
		});

		it("reports absent spend beside measured tokens when the agent context carried no price", () => {
			const dir = writeResult("task_g__ggg7777", {
				...passed,
				agent_result: { n_input_tokens: 900, n_output_tokens: 120, n_cache_tokens: 700 },
			});

			expect(usageOf(trialOf(dir, "task_g__ggg7777"))).toEqual({
				costUsd: null,
				tokCache: 700,
				tokIn: 900,
				tokOut: 120,
			});
		});

		it("reports absent values for fields that are present but not finite numbers", () => {
			const dir = writeResult("task_h__hhh8888", {
				...passed,
				agent_result: { cost_usd: null, n_input_tokens: "900", n_output_tokens: Number.NaN, n_cache_tokens: 5 },
			});

			expect(usageOf(trialOf(dir, "task_h__hhh8888"))).toEqual({
				costUsd: null,
				tokCache: 5,
				tokIn: null,
				tokOut: null,
			});
		});

		it("sums only the step contexts that measured a field", () => {
			const dir = writeResult("task_i__iii9999", {
				...passed,
				step_results: [
					{ agent_result: { cost_usd: 0.25, n_input_tokens: 10 } },
					{ agent_result: { n_input_tokens: 15 } },
				],
			});

			expect(usageOf(trialOf(dir, "task_i__iii9999"))).toEqual({
				costUsd: 0.25,
				tokCache: null,
				tokIn: 25,
				tokOut: null,
			});
		});
	});

	describe("job totals", () => {
		const trial = (over: Partial<Trial>): Trial => ({
			name: "t",
			status: "pass",
			reward: 1,
			costUsd: null,
			tokIn: null,
			tokOut: null,
			tokCache: null,
			durationMs: 1,
			detail: "",
			...over,
		});

		it("reports absent totals for a job whose trials measured nothing", () => {
			const totals = aggregate([trial({}), trial({ status: "fail", reward: 0 })], null, 2);

			expect({
				costUsd: totals.costUsd,
				tokIn: totals.tokIn,
				tokOut: totals.tokOut,
				tokCache: totals.tokCache,
			}).toEqual({ costUsd: null, tokIn: null, tokOut: null, tokCache: null });
			expect([totals.pass, totals.fail, totals.done, totals.pending]).toEqual([1, 1, 2, 0]);
		});

		it("sums the measured trials and ignores the unmeasured ones", () => {
			const totals = aggregate(
				[
					trial({ costUsd: 0.5, tokIn: 100, tokOut: 10, tokCache: 4 }),
					trial({ status: "error", reward: null }),
					trial({ status: "running", reward: null, costUsd: 0.25, tokIn: 20 }),
				],
				null,
				4,
			);

			expect(totals.costUsd).toBeCloseTo(0.75);
			expect([totals.tokIn, totals.tokOut, totals.tokCache]).toEqual([120, 10, 4]);
			expect([totals.pass, totals.error, totals.running, totals.done, totals.pending]).toEqual([1, 1, 1, 2, 1]);
		});

		it("reports absent totals for a job with no trials at all", () => {
			const totals = aggregate([], null, 3);

			expect([totals.costUsd, totals.tokIn, totals.tokOut, totals.tokCache]).toEqual([null, null, null, null]);
			expect(totals.pending).toBe(3);
		});
	});

	describe("what the operator reads", () => {
		it("marks an absent amount and keeps a measured zero", () => {
			expect(fmtUsd(null)).toBe("—");
			expect(fmtUsd(0)).toBe("$0.000");
			expect(fmtNum(null)).toBe("—");
			expect(fmtNum(0)).toBe("0");
		});

		it("prints an absent cost in a trial's report row", () => {
			const row = renderTrialRow({
				name: "task_j__jjj0000",
				status: "pass",
				reward: 1,
				costUsd: null,
				tokIn: null,
				tokOut: null,
				tokCache: null,
				durationMs: 2000,
				detail: "",
			});

			expect(row).toBe("| task_j__jjj0000 | ✅ pass | 1.00 | — | 2s |  |");
		});

		it("writes a report that says the run's spend and tokens were never measured", () => {
			const dir = trialDir("task_k__kkk1111");
			fs.writeFileSync(
				path.join(dir, "result.json"),
				JSON.stringify({ verifier_result: { rewards: { reward: 1 } } }),
			);
			const benchDir = path.join(root, "_bench");
			fs.mkdirSync(benchDir, { recursive: true });
			const state: RenderState = {
				cfg: defaultConfig(),
				jobDir: root,
				logPath: path.join(benchDir, "harbor.log"),
				startMs: Date.now() - 1000,
				expected: 1,
				tick: 0,
			};

			const report = fs.readFileSync(writeReport(state, benchDir, 0), "utf8");

			expect(report).toContain("- **Spend:** —");
			expect(report).toContain("- **Tokens:** in —, out —, cache —");
			expect(report).not.toContain("$0.000");
			expect(readTrials(root)[0]?.costUsd).toBeNull();
		});
	});

	describe("the manager snapshot of the same job", () => {
		function writeTrial(name: string, result: Record<string, unknown>): void {
			const dir = trialDir(name);
			fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result));
		}

		it("reports absent spend and cache for trials that measured neither", () => {
			writeTrial("task_l__lll2222", {
				verifier_result: { rewards: { reward: 1 } },
				agent_result: { n_input_tokens: 40, n_output_tokens: 4 },
			});

			const snapshot = readBenchmarkSnapshot("harbor", root);

			expect(snapshot.costUsd).toBeNull();
			expect(snapshot.tokCache).toBeNull();
			expect([snapshot.tokIn, snapshot.tokOut]).toEqual([40, 4]);
			expect(snapshot.traces[0]?.costUsd).toBeNull();
		});

		it("sums the priced trials only", () => {
			writeTrial("task_m__mmm3333", {
				verifier_result: { rewards: { reward: 1 } },
				agent_result: { cost_usd: 0.125, n_input_tokens: 10, n_cache_tokens: 3 },
			});
			writeTrial("task_n__nnn4444", {
				verifier_result: { rewards: { reward: 0 } },
				agent_result: { n_input_tokens: 10 },
			});

			const snapshot = readBenchmarkSnapshot("harbor", root);

			expect(snapshot.costUsd).toBeCloseTo(0.125);
			expect(snapshot.tokCache).toBe(3);
			expect([snapshot.pass, snapshot.fail, snapshot.done]).toEqual([1, 1, 2]);
		});

		it("calls a trial whose verifier recorded no reward an error, exactly as the runner does", () => {
			writeTrial("task_o__ooo5555", { agent_result: { cost_usd: 0.5 }, finished_at: "2025-01-01T00:00:01Z" });

			const snapshot = readBenchmarkSnapshot("harbor", root);
			const runnerTrial = trialOf(path.join(root, "task_o__ooo5555"), "task_o__ooo5555");

			expect(snapshot.traces[0]?.status).toBe("error");
			expect(runnerTrial.status).toBe("error");
			expect(runnerTrial.detail).toBe("missing or unparsable reward");
			// An ungraded trial is not a fail: it stays out of the pass rate's denominator as an error.
			expect([snapshot.pass, snapshot.fail, snapshot.error]).toEqual([0, 0, 1]);
		});
	});
});
