import { describe, expect, test } from "bun:test";

import { trialQueue } from "../../../src/suites/deep-swe/src/aggregate/merge";
import { drainTrialQueueInPairedWaves } from "../../../src/suites/deep-swe/src/runner/trial-scheduler";

/**
 * WHY: a generic two-worker queue can let a faster arm claim another task while
 * its counterpart is still running. That breaks the one-slot-per-arm comparison
 * and exposes later tasks to different provider load. This suite proves each
 * task's arms start together and the next task cannot start until both settle.
 * It does not cover Pier's container lifecycle after a trial process exits.
 */
describe("paired trial waves", () => {
	test("one faster arm cannot advance before its counterpart", async () => {
		const queue = trialQueue(["baseline", "candidate"], ["task-a", "task-b"], 1);
		const gates = new Map(queue.map(trial => [`${trial.arm}/${trial.task}`, Promise.withResolvers<void>()] as const));
		const started: string[] = [];
		const secondWaveStarted = Promise.withResolvers<void>();

		const execution = drainTrialQueueInPairedWaves(queue, {
			armsPerWave: 2,
			shouldStop: () => false,
			run: async trial => {
				const key: `${string}/${string}` = `${trial.arm}/${trial.task}`;
				started.push(key);
				if (trial.task === "task-b") secondWaveStarted.resolve();
				await gates.get(key)!.promise;
			},
		});

		await Promise.resolve();
		expect(started).toEqual(["baseline/task-a", "candidate/task-a"]);

		gates.get("baseline/task-a")!.resolve();
		await Promise.resolve();
		expect(started).toEqual(["baseline/task-a", "candidate/task-a"]);

		gates.get("candidate/task-a")!.resolve();
		await secondWaveStarted.promise;
		expect(started).toEqual(["baseline/task-a", "candidate/task-a", "baseline/task-b", "candidate/task-b"]);

		gates.get("baseline/task-b")!.resolve();
		gates.get("candidate/task-b")!.resolve();
		await execution;
		expect(queue).toEqual([]);
	});

	test("rejects a wave that is missing or duplicates an arm", async () => {
		const started: string[] = [];
		await expect(
			drainTrialQueueInPairedWaves(
				[
					{ arm: "baseline", task: "task-a", repeat: 0 },
					{ arm: "baseline", task: "task-b", repeat: 0 },
				],
				{
					armsPerWave: 2,
					shouldStop: () => false,
					run: async trial => {
						started.push(trial.arm);
					},
				},
			),
		).rejects.toThrow("paired wave is not one complete arm set");
		expect(started).toEqual([]);
	});
});
