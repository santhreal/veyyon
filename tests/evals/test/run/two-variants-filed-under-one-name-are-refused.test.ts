/**
 * WHY: a trial is filed under its variant's name made into a path segment, where every character
 * but letters, digits, ".", "_" and "-" becomes "_". Two variants whose names differ only in those
 * characters shared one trial directory and, on the local-cli backend, one scratch directory: each
 * trial's start deleted the other's files, and the journal and report named two arms that had
 * written over each other.
 *
 * The cases plan runs whose variant names collide that way, on the model axis and on the build
 * axis, and assert the plan is refused naming both variants; a plan whose names stay apart is
 * planned.
 *
 * Not caught: a collision between two runs' ids, which name different run directories.
 */
import { describe, expect, it } from "bun:test";
import type { EvalSuite, PreflightVerdict, TaskDescriptor, TrialScore } from "../../engine/contracts";
import { harnesses } from "../../engine/members/loaded";
import { buildRunPlan, VariantSegmentCollisionError } from "../../engine/plan/run-plan";
import type { VariantMatrixSelection } from "../../engine/plan/variant-matrix";

const suite: EvalSuite = {
	id: "collision-probe",
	version: "1.0.0",
	displayName: "Collision probe",
	description: "one task, planned under colliding variant names",
	backend: "in-process",
	async discoverTasks(): Promise<readonly string[]> {
		return ["task"];
	},
	async describeTask(taskId: string): Promise<TaskDescriptor> {
		return { id: taskId, path: null, timeBudgetSec: 60, instructionPath: null, metadata: {} };
	},
	async provenance() {
		return { suite: "collision-probe", version: "1.0.0", sha: null };
	},
	async scoreTrial(): Promise<TrialScore> {
		return { reward: 1, partial: null, error: null, usage: null, extra: {} };
	},
	async preflight(): Promise<PreflightVerdict> {
		return { ok: true };
	},
};

describe("a plan whose variant names become one directory name", () => {
	it.each([
		[
			"two models",
			{ harnesses: ["veyyon"], models: ["vendor/a:b", "vendor/a/b"] },
			"veyyon@vendor/a:b",
			"veyyon@vendor/a/b",
		],
		[
			"two builds",
			{ harnesses: ["veyyon"], models: ["vendor/model"], builds: ["new build=/src/one", "new_build=/src/two"] },
			"veyyon#new build",
			"veyyon#new_build",
		],
	] as [string, VariantMatrixSelection, string, string][])(
		"is refused for %s, naming both",
		async (_label, selection, first, second) => {
			const planning = buildRunPlan({ suite, harnesses, selection });

			await expect(planning).rejects.toThrow(VariantSegmentCollisionError);
			await expect(planning).rejects.toThrow(`"${first}" and "${second}"`);
		},
	);

	it("is planned when the names stay apart", async () => {
		const plan = await buildRunPlan({
			suite,
			harnesses,
			selection: { harnesses: ["veyyon"], models: ["vendor/a-b", "vendor/a-c"] },
		});

		expect(plan.variants.map(variant => variant.name)).toEqual(["veyyon@vendor/a-b", "veyyon@vendor/a-c"]);
	});
});
