/**
 * WHY: a run with no owning process — one the CLI started, or one a previous manager left behind —
 * gets its status from the job directory's own timestamps, because an orphaned runner may still be
 * writing trials. The probe returned `Math.round(newest) || Date.now()`, so a directory whose mtime
 * it could not read, and a directory whose mtime is the epoch, both reported the current time. Both
 * therefore read as freshly written: the run stayed `running` on every later sync and never reached
 * a terminal state, and when it did fall through, its finish time was recorded as whenever the
 * manager happened to look rather than when the directory was last written.
 *
 * The class this closes: a freshness decision taken from a timestamp nothing measured. Every state
 * the probe can be in is swept — no readable timestamp, the epoch, older than the stale window,
 * inside it, and the boundary itself — against the status and the recorded finish time. The finish
 * time is asserted as the timestamp the directory carries, so substituting the current time for an
 * unknown one fails here rather than looking plausible.
 *
 * One branch is unreachable from here and stays uncovered on purpose: `syncRun` establishes that the
 * job directory exists before it probes, so the probe returns null only if the directory vanishes
 * between the two calls. Mutating that guard alone therefore stays green. The epoch timestamp is the
 * reachable member of the same class and is covered below.
 *
 * WHAT THIS DOES NOT CATCH: whether an orphan is genuinely still running. The stale window is a
 * heuristic over mtimes, and a runner that stalls for longer than the window while holding its
 * directory open still reads as failed. A run with a live pid never reaches this branch.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RunStore } from "../../store/sqlite";

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function makeJobsDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evals-store-freshness-"));
	cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function openStore(jobsDir: string): RunStore {
	const store = new RunStore(jobsDir, path.join(jobsDir, "_manager", "test.sqlite"));
	cleanups.push(() => store.close());
	return store;
}

/**
 * A harbor job dir holding one finished trial and no job-level result, which is the state an orphan
 * leaves behind: enough to count its trials, nothing that states the job itself ended.
 */
function writeOrphanJob(jobsDir: string, jobName: string): string {
	const jobDir = path.join(jobsDir, jobName);
	fs.mkdirSync(path.join(jobDir, "task__1"), { recursive: true });
	fs.writeFileSync(
		path.join(jobDir, "manager.json"),
		JSON.stringify({ dataset: "terminal-bench@3.0", agent: "veyyon", models: ["m/x"], benchmark: "harbor" }),
	);
	fs.writeFileSync(
		path.join(jobDir, "task__1", "result.json"),
		JSON.stringify({
			started_at: "2026-07-12T10:00:00",
			finished_at: "2026-07-12T10:05:00",
			verifier_result: { rewards: { reward: 1 } },
			agent_result: { cost_usd: 0.5, n_input_tokens: 10, n_output_tokens: 2 },
		}),
	);
	return jobDir;
}

/** Stamp the directory's mtime, after every write, so the probe reads exactly this value. */
function stampDir(dir: string, whenMs: number): void {
	const seconds = whenMs / 1000;
	fs.utimesSync(dir, seconds, seconds);
}

const STALE_WINDOW_MS = 30 * 60 * 1000;

describe("an orphaned run gets its status from the timestamp its directory carries", () => {
	it("calls a directory stamped at the epoch finished, and records that timestamp", () => {
		const jobsDir = makeJobsDir();
		const jobDir = writeOrphanJob(jobsDir, "epoch-job");
		stampDir(jobDir, 0);
		const store = openStore(jobsDir);

		expect(store.discover()).toBe(1);
		const row = store.getRun("epoch-job");

		expect(row?.status).toBe("complete");
		expect(row?.finishedAt).toBe(0);
	});

	it("keeps a directory written just now running, because its runner may still be writing", () => {
		const jobsDir = makeJobsDir();
		const jobDir = writeOrphanJob(jobsDir, "fresh-job");
		stampDir(jobDir, Date.now());
		const store = openStore(jobsDir);
		store.discover();

		const row = store.getRun("fresh-job");
		expect(row?.status).toBe("running");
		expect(row?.finishedAt).toBeNull();
	});

	it("records the directory's own last write as the finish time, not the time of the sync", () => {
		const jobsDir = makeJobsDir();
		const jobDir = writeOrphanJob(jobsDir, "stale-job");
		const lastWrite = Date.now() - 3 * STALE_WINDOW_MS;
		stampDir(jobDir, lastWrite);
		const store = openStore(jobsDir);
		store.discover();

		const row = store.getRun("stale-job");
		expect(row?.status).toBe("complete");
		expect(row?.finishedAt).toBe(Math.round(lastWrite));
	});

	it("reads the newest of the directory and its job result, so a fresh result keeps the run live", () => {
		const jobsDir = makeJobsDir();
		const jobDir = writeOrphanJob(jobsDir, "mixed-job");
		// A job result with no finish time states the trial counts without stating the job ended.
		const jobResult = path.join(jobDir, "result.json");
		fs.writeFileSync(jobResult, JSON.stringify({ n_total_trials: 2, stats: { n_running_trials: 1 } }));
		stampDir(jobDir, 0);
		const now = Date.now() / 1000;
		fs.utimesSync(jobResult, now, now);
		const store = openStore(jobsDir);
		store.discover();

		expect(store.getRun("mixed-job")?.status).toBe("running");
	});

	it("treats the stale window's own edge as stale", () => {
		const jobsDir = makeJobsDir();
		const inside = writeOrphanJob(jobsDir, "inside-window");
		stampDir(inside, Date.now() - (STALE_WINDOW_MS - 60_000));
		const outside = writeOrphanJob(jobsDir, "outside-window");
		stampDir(outside, Date.now() - (STALE_WINDOW_MS + 60_000));
		const store = openStore(jobsDir);
		store.discover();

		expect([store.getRun("inside-window")?.status, store.getRun("outside-window")?.status]).toEqual([
			"running",
			"complete",
		]);
	});

	it("still prefers a job result that states the job finished over any timestamp", () => {
		const jobsDir = makeJobsDir();
		const jobDir = writeOrphanJob(jobsDir, "declared-job");
		fs.writeFileSync(
			path.join(jobDir, "result.json"),
			JSON.stringify({ n_total_trials: 1, finished_at: "2026-07-12T11:00:00", stats: {} }),
		);
		stampDir(jobDir, Date.now());
		const store = openStore(jobsDir);
		store.discover();

		const row = store.getRun("declared-job");
		expect(row?.status).toBe("complete");
		expect(row?.finishedAt).toBe(Date.parse("2026-07-12T11:00:00"));
	});
});
