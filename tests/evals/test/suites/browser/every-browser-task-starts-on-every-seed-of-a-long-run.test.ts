/**
 * WHY: a task's planner bends seeded data until the answer is unique, and a planner that throws
 * when the draw does not work out leaves that seed with no trial at all: the run records an error
 * for every arm on that repeat. `analytics-export-segment` threw on the seed of repeat 56, where a
 * small segment earned the same over the shifted range and the preset's own range. The suite's
 * sweep meets only the first four seeds, so nothing ran into it.
 *
 * This suite starts every task of the browser suite, as the suite lists them, on the seed of every
 * repeat a 64-repeat run meets, and stops it again. A new task joins without an edit here.
 *
 * Not caught: a planner that fails on a seed past repeat 63, and a started trial whose checks
 * cannot pass, which the sweep covers for its seeds.
 */
import { describe, expect, it } from "bun:test";
import { TempDir } from "@veyyon/utils";
import { trialSeed } from "../../../engine/kit/suite";
import { BROWSER_TASKS } from "../../../suites/browser/main";

const REPEATS = 64;

describe("every browser task", () => {
	for (const task of BROWSER_TASKS) {
		it(`${task.id} starts on the seed of every repeat below ${REPEATS}`, async () => {
			const failures: string[] = [];
			for (let repeat = 0; repeat < REPEATS; repeat++) {
				await using dir = await TempDir.create("@evals-browser-seeds-");
				try {
					const trial = await task.start({
						seed: trialSeed({ task: task.id, repeat }),
						workspace: dir.path(),
						trialDir: dir.path(),
					});
					await trial.finish();
				} catch (error) {
					failures.push(`repeat ${repeat}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			expect(failures).toEqual([]);
		});
	}
});
