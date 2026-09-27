/**
 * The sweep every kit task list passes: over several seeds, the task's scripted solution passes
 * every check, and a trial in which nothing happens fails. The state is round-tripped through JSON,
 * as a suite writes it to `state.json` for the grader.
 */
import { describe, expect, it } from "bun:test";
import { TempDir } from "@veyyon/utils";
import type { KitTask } from "../../../engine/kit/catalog";
import type { Grade } from "../../../engine/kit/checks";
import { trialSeed } from "../../../engine/kit/suite";

/** A plan numbers repeats from 1, so these are the seeds a `--repeats 3` run meets, and one more. */
const REPEATS = [0, 1, 2, 3];

/** Start one trial, solve it or not, stop it, and grade what it recorded. */
async function run(task: KitTask, repeat: number, solve: boolean): Promise<Grade> {
	await using dir = await TempDir.create("@evals-kit-task-");
	const trial = await task.start({
		seed: trialSeed({ task: task.id, repeat }),
		workspace: dir.path(),
		trialDir: dir.path(),
	});
	let answer = "";
	let failure: unknown = null;
	try {
		if (solve) answer = await trial.solve();
	} catch (error) {
		failure = error;
	}
	// Stopped whether or not the solution threw, so a failing case leaves no server behind.
	const state: unknown = JSON.parse(JSON.stringify(await trial.finish()));
	if (failure !== null) throw failure;
	return task.grade(state, answer);
}

export function sweepTasks(tasks: readonly KitTask[]): void {
	for (const task of tasks) {
		describe(task.id, () => {
			for (const repeat of REPEATS) {
				it(`passes every check when solved, seed of repeat ${repeat}`, async () => {
					const grade = await run(task, repeat, true);
					expect(grade.outcomes.filter(outcome => !outcome.passed).map(outcome => outcome.id)).toEqual([]);
					expect(grade.reward).toBe(1);
				});

				it(`fails when nothing is done, seed of repeat ${repeat}`, async () => {
					const grade = await run(task, repeat, false);
					expect(grade.reward).toBe(0);
				});
			}
		});
	}
}
