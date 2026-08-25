/**
 * @file Regression test: Acknowledging a watched completed job before unwatching delivers it exactly once.
 *
 * WHY:
 * When a watched background job completed under zero retention (`retentionMs: 0`),
 * `acknowledgeDeliveries` prematurely cleared the job ID from `#suppressedDeliveries`
 * while the job was still watched and still present in `#jobs`. When the caller then
 * performed the required `unwatchJobs` step, `#requeueSettledDelivery` observed that
 * suppression was gone and re-enqueued the completed job, delivering the same report
 * a second time via `onJobComplete`.
 *
 * CLASS IT CLOSES:
 * Delivery suppression must remain armed as long as the job record is live in `#jobs`
 * and reachable by re-arming transitions (such as `unwatchJobs`). Eviction must be the
 * single owner that purges `#suppressedDeliveries` alongside `#jobs`.
 *
 * GAP IT LEAVES:
 * Does not prevent explicit caller requests to re-arm via `resumeDeliveries()`, which
 * is intended to disarm suppression and re-enqueue delivery on demand.
 */

import { afterEach, describe, expect, test, vi } from "bun:test";
import { AsyncJobManager } from "../src/async/job-manager";

describe("watched job acknowledged before unwatch delivery contract", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("retentionMs: 0 delivers exactly once when caller acknowledges before unwatch and evicts immediately", async () => {
		const delivered: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async (jobId, text) => {
				delivered.push({ jobId, text });
			},
		});

		const gate = Promise.withResolvers<string>();
		const jobId = manager.register("task", "watched child", () => gate.promise);

		manager.watchJobs([jobId]);
		gate.resolve("child report payload");
		await manager.waitForAll();

		// Job completed while watched — suppressed from automatic background delivery
		expect(delivered).toEqual([]);
		expect(manager.getJob(jobId)?.status).toBe("completed");

		// Caller receives the report directly and acknowledges delivery before lifting the watch
		const directResult = manager.getJob(jobId)?.resultText;
		expect(directResult).toBe("child report payload");

		manager.acknowledgeDeliveries([jobId]);
		manager.unwatchJobs([jobId]);

		const drained = await manager.drainDeliveries({ timeoutMs: 1_000 });
		expect(drained).toBe(true);

		// No duplicate delivery occurred via onJobComplete
		expect(delivered).toEqual([]);

		// Zero retention: record is purged immediately upon unwatch
		expect(manager.getJob(jobId)).toBeUndefined();
	});

	test("non-zero retention delivers exactly once across acknowledge-then-unwatch and evicts within bound", async () => {
		vi.useFakeTimers();
		const delivered: Array<{ jobId: string; text: string }> = [];
		const retentionMs = 100;
		const manager = new AsyncJobManager({
			retentionMs,
			onJobComplete: async (jobId, text) => {
				delivered.push({ jobId, text });
			},
		});

		const gate = Promise.withResolvers<string>();
		const jobId = manager.register("task", "non-zero retention watched task", () => gate.promise);

		manager.watchJobs([jobId]);
		gate.resolve("retained report payload");
		await manager.waitForAll();

		expect(delivered).toEqual([]);
		expect(manager.getJob(jobId)?.resultText).toBe("retained report payload");

		manager.acknowledgeDeliveries([jobId]);
		manager.unwatchJobs([jobId]);

		const drained = await manager.drainDeliveries({ timeoutMs: 1_000 });
		expect(drained).toBe(true);

		// No duplicate delivery occurred
		expect(delivered).toEqual([]);

		// Immediately after unwatch, the job record still exists pending the retention timer
		expect(manager.getJob(jobId)).toBeDefined();

		// Advancing before the bound does not evict early
		vi.advanceTimersByTime(retentionMs - 1);
		expect(manager.getJob(jobId)).toBeDefined();

		// Advancing past the retention bound triggers eviction
		vi.advanceTimersByTime(1);
		expect(manager.getJob(jobId)).toBeUndefined();
	});

	test("batch of watched jobs with zero retention delivers zero duplicate notifications and evicts all records", async () => {
		const delivered: Array<{ jobId: string; text: string }> = [];
		const manager = new AsyncJobManager({
			retentionMs: 0,
			onJobComplete: async (jobId, text) => {
				delivered.push({ jobId, text });
			},
		});

		const gates = [Promise.withResolvers<string>(), Promise.withResolvers<string>(), Promise.withResolvers<string>()];
		const jobIds = gates.map((gate, i) => manager.register("task", `batch-${i}`, () => gate.promise));

		manager.watchJobs(jobIds);
		for (let i = 0; i < gates.length; i++) {
			gates[i].resolve(`batch result ${i}`);
		}
		await manager.waitForAll();

		manager.acknowledgeDeliveries(jobIds);
		manager.unwatchJobs(jobIds);

		const drained = await manager.drainDeliveries({ timeoutMs: 1_000 });
		expect(drained).toBe(true);

		expect(delivered).toEqual([]);
		for (const id of jobIds) {
			expect(manager.getJob(id)).toBeUndefined();
		}
	});
});
