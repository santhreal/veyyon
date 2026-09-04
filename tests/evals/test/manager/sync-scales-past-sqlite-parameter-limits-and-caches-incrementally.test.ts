/**
 * WHY:
 * A 5,000-trial evaluation run throws a SQLite parameter limit error (>999 host parameters)
 * when syncRun builds a dynamic `NOT IN (?, ?, ...)` query for trial pruning. Furthermore,
 * polling re-reads and re-parses every trial's result.json on disk every 2 seconds, causing
 * O(all results) I/O and CPU waste instead of O(new results).
 *
 * This suite closes the class by proving:
 *  1. Syncing runs with 1,200+ trials (well past 999) completes without parameter limit errors.
 *  2. Second and subsequent sync ticks cost O(new results), parsing zero files when unchanged
 *     and exactly N files when N new trial results appear.
 *  3. Vanished trial pruning correctly cleans up obsolete trials without parameter limit issues.
 */

import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearBenchmarkCache, getFilesParsedCount, resetFilesParsedCount } from "../../store/benchmarks";
import { RunStore } from "../../store/sqlite";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
	clearBenchmarkCache();
});

function makeTempJobsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-scale-test-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function writeTrialResult(jobDir: string, trialName: string, reward: number): void {
	const trialDir = path.join(jobDir, trialName);
	fs.mkdirSync(path.join(trialDir, "agent"), { recursive: true });
	fs.writeFileSync(
		path.join(trialDir, "result.json"),
		JSON.stringify({
			started_at: "2026-08-25T10:00:00.000Z",
			finished_at: "2026-08-25T10:01:00.000Z",
			verifier_result: { rewards: { reward } },
			agent_result: { cost_usd: 0.05, n_input_tokens: 500, n_output_tokens: 50, n_cache_tokens: 200 },
		}),
	);
}

describe("RunStore large-scale sync and incremental caching", () => {
	it("syncs over 1,200+ trials without exceeding SQLite 999 parameter limits and tracks incremental cost", () => {
		const jobsDir = makeTempJobsDir();
		const jobName = "massive-harbor-run";
		const jobDir = path.join(jobsDir, jobName);
		fs.mkdirSync(jobDir, { recursive: true });

		const TOTAL_TRIALS = 1250;
		expect(TOTAL_TRIALS).toBeGreaterThan(999);

		fs.writeFileSync(
			path.join(jobDir, "result.json"),
			JSON.stringify({
				n_total_trials: TOTAL_TRIALS,
				stats: { n_running_trials: 0, n_pending_trials: 0 },
			}),
		);
		fs.writeFileSync(
			path.join(jobDir, "config.json"),
			JSON.stringify({
				dataset: "terminal-bench@2.0",
				agents: [{ name: "veyyon", model_name: "anthropic/claude-opus-4-8" }],
			}),
		);

		// Seed initial 1,200 trials (all finished)
		for (let i = 0; i < 1200; i++) {
			const taskName = `task_${String(i).padStart(4, "0")}`;
			writeTrialResult(jobDir, `${taskName}__run1`, i % 2 === 0 ? 1 : 0);
		}

		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		resetFilesParsedCount();

		// Tick 1: Initial discovery and sync of 1,200 trials
		expect(store.discover()).toBe(1);
		const initialRun = store.getRun(jobName);
		expect(initialRun).not.toBeNull();
		expect(initialRun?.nTotal).toBe(TOTAL_TRIALS);
		expect(initialRun?.done).toBe(1200);
		expect(initialRun?.pass).toBe(600);
		expect(initialRun?.fail).toBe(600);

		// Observable cost: all 1,200 trial files + 1 job result.json were parsed on initial read
		const initialParsed = getFilesParsedCount();
		expect(initialParsed).toBe(1201);

		// Tick 2: Second sync with no new results on disk
		resetFilesParsedCount();
		const secondSync = store.syncRun(jobName);
		expect(secondSync?.done).toBe(1200);
		// Observable cost: 0 trial files re-parsed from disk because mtimes are unchanged
		expect(getFilesParsedCount()).toBe(0);

		// Tick 3: N new results written (50 new trials added, bringing total to 1,250)
		for (let i = 1200; i < 1250; i++) {
			const taskName = `task_${String(i).padStart(4, "0")}`;
			writeTrialResult(jobDir, `${taskName}__run1`, 1);
		}

		resetFilesParsedCount();
		const thirdSync = store.syncRun(jobName);
		expect(thirdSync?.done).toBe(1250);
		expect(thirdSync?.pass).toBe(650);
		expect(thirdSync?.fail).toBe(600);

		// Observable cost: exactly 50 new trial files parsed, NOT 1,250!
		expect(getFilesParsedCount()).toBe(50);

		// Verify database rows in SQLite
		const traces = store.listTraces(jobName);
		expect(traces).toHaveLength(1250);
	});

	it("prunes vanished trials when trial count exceeds SQLite parameter limit", () => {
		const jobsDir = makeTempJobsDir();
		const jobName = "prune-scale-run";
		const jobDir = path.join(jobsDir, jobName);
		fs.mkdirSync(jobDir, { recursive: true });

		fs.writeFileSync(path.join(jobDir, "result.json"), JSON.stringify({ n_total_trials: 1100 }));
		fs.writeFileSync(
			path.join(jobDir, "config.json"),
			JSON.stringify({ dataset: "terminal-bench@2.0", agents: [{ name: "veyyon", model_name: "m" }] }),
		);

		for (let i = 0; i < 1100; i++) {
			writeTrialResult(jobDir, `trial_${String(i).padStart(4, "0")}__r1`, 1);
		}

		const store = new RunStore(jobsDir);
		cleanups.push(() => store.close());

		store.discover();
		expect(store.listTraces(jobName)).toHaveLength(1100);

		// Simulate trial eviction / resume pruning (remove 100 trials from disk)
		for (let i = 1000; i < 1100; i++) {
			fs.rmSync(path.join(jobDir, `trial_${String(i).padStart(4, "0")}__r1`), { recursive: true, force: true });
		}

		// Sync must prune the 100 vanished trials without dynamic NOT IN query failing
		const synced = store.syncRun(jobName);
		expect(synced?.done).toBe(1000);
		expect(store.listTraces(jobName)).toHaveLength(1000);
	});
});
