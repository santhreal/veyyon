import { describe, expect, it } from "bun:test";
import {
	dispatchWorkflowAndWait,
	publishPreparedRelease,
	type ReleaseWorkflowOperations,
	type WorkflowRunEvidence,
} from "./release";

const TAG = "v1.2.3";
const SHA = "release-sha";

function evidence(overrides: Partial<WorkflowRunEvidence> = {}): WorkflowRunEvidence {
	return {
		path: ".github/workflows/checks.yml",
		event: "workflow_dispatch",
		headBranch: TAG,
		headSha: SHA,
		displayTitle: "Checks release gate 9001-2-checks",
		actor: "github-actions[bot]",
		...overrides,
	};
}

function operations(overrides: Partial<ReleaseWorkflowOperations>): ReleaseWorkflowOperations {
	return {
		listRunIds: async () => [],
		dispatch: async () => {},
		runEvidence: async () => evidence(),
		watch: async () => {},
		sleep: async () => {},
		verifyPublished: async () => "https://github.com/santhreal/veyyon/releases/tag/v1.2.3",
		...overrides,
	};
}

describe("release workflow run correlation", () => {
	/**
	 * A pre-existing green run cannot mask a red run created by this release.
	 * The controller must watch the new run and surface its exact failure.
	 */
	it("watches the newly dispatched run instead of an old success", async () => {
		let listCalls = 0;
		const watched: number[] = [];
		const releaseOperations = operations({
			listRunIds: async () => (++listCalls === 1 ? [101] : [101, 201]),
			runEvidence: async id => {
				expect(id).toBe(201);
				return evidence();
			},
			watch: async id => {
				watched.push(id);
				throw new Error("Checks failed");
			},
		});

		await expect(
			dispatchWorkflowAndWait(
				{
					workflow: "checks.yml",
					label: "Checks",
					tag: TAG,
					sha: SHA,
					expectedTitle: "Checks release gate 9001-2-checks",
				},
				releaseOperations,
			),
		).rejects.toThrow("Checks failed");
		expect(watched).toEqual([201]);
	});

	/**
	 * Publication is a strict state machine: Checks completes first, then tagged
	 * CI completes, then the final GitHub release manifest is verified.
	 */
	it("waits for Checks and CI before verifying final publication", async () => {
		const previousRunId = Bun.env.GITHUB_RUN_ID;
		const previousAttempt = Bun.env.GITHUB_RUN_ATTEMPT;
		Bun.env.GITHUB_RUN_ID = "9001";
		Bun.env.GITHUB_RUN_ATTEMPT = "2";
		const events: string[] = [];
		const listCalls = new Map<string, number>();
		const releaseOperations = operations({
			listRunIds: async workflow => {
				const calls = (listCalls.get(workflow) ?? 0) + 1;
				listCalls.set(workflow, calls);
				if (workflow === "checks.yml") return calls === 1 ? [101] : [101, 201];
				return calls === 1 ? [102] : [102, 202];
			},
			dispatch: async (workflow, ref, inputs) => {
				events.push(`dispatch:${workflow}:${ref}:${JSON.stringify(inputs)}`);
			},
			runEvidence: async id =>
				id === 201
					? evidence()
					: evidence({
							path: ".github/workflows/ci.yml",
							displayTitle: "CI release gate 9001-2-ci",
						}),
			watch: async id => {
				events.push(`watch:${id}`);
			},
			verifyPublished: async tag => {
				events.push(`verify:${tag}`);
				return "https://github.com/santhreal/veyyon/releases/tag/v1.2.3";
			},
		});

		try {
			const result = await publishPreparedRelease(TAG, SHA, releaseOperations);
			expect(result).toEqual({
				checksRunId: 201,
				ciRunId: 202,
				url: "https://github.com/santhreal/veyyon/releases/tag/v1.2.3",
			});
			expect(events).toEqual([
				'dispatch:checks.yml:v1.2.3:{"release_nonce":"9001-2-checks"}',
				"watch:201",
				'dispatch:ci.yml:v1.2.3:{"release_nonce":"9001-2-ci"}',
				"watch:202",
				"verify:v1.2.3",
			]);
		} finally {
			if (previousRunId === undefined) delete Bun.env.GITHUB_RUN_ID;
			else Bun.env.GITHUB_RUN_ID = previousRunId;
			if (previousAttempt === undefined) delete Bun.env.GITHUB_RUN_ATTEMPT;
			else Bun.env.GITHUB_RUN_ATTEMPT = previousAttempt;
		}
	});

	/**
	 * A concurrent exact-SHA dispatch has the same ref and commit. Its run title
	 * cannot satisfy the nonce-bound Checks correlation for this release.
	 */
	it("ignores a competing run and watches the nonce-correlated run", async () => {
		let listCalls = 0;
		const watched: number[] = [];
		const releaseOperations = operations({
			listRunIds: async () => (++listCalls === 1 ? [101] : [101, 301, 201]),
			runEvidence: async id =>
				id === 301 ? evidence({ displayTitle: "Checks release gate competing-dispatch" }) : evidence(),
			watch: async id => {
				watched.push(id);
			},
		});

		const id = await dispatchWorkflowAndWait(
			{
				workflow: "checks.yml",
				label: "Checks",
				tag: TAG,
				sha: SHA,
				expectedTitle: "Checks release gate 9001-2-checks",
			},
			releaseOperations,
		);
		expect(id).toBe(201);
		expect(watched).toEqual([201]);
	});

	/**
	 * Every immutable run identity field is mandatory. Wrong workflow, event,
	 * tag, SHA, actor, or nonce must time out without watching the foreign run.
	 */
	it("fails closed on mismatched run evidence", async () => {
		const cases: Array<[string, Partial<WorkflowRunEvidence>]> = [
			["workflow", { path: ".github/workflows/ci.yml" }],
			["event", { event: "push" }],
			["tag", { headBranch: "main" }],
			["SHA", { headSha: "older-sha" }],
			["actor", { actor: "release-operator" }],
			["nonce", { displayTitle: "Checks release gate another-cutter" }],
		];
		for (const [field, override] of cases) {
			let listCalls = 0;
			const watched: number[] = [];
			const releaseOperations = operations({
				listRunIds: async () => (++listCalls === 1 ? [101] : [101, 201]),
				runEvidence: async () => evidence(override),
				watch: async id => {
					watched.push(id);
				},
			});
			await expect(
				dispatchWorkflowAndWait(
					{
						workflow: "checks.yml",
						label: "Checks",
						tag: TAG,
						sha: SHA,
						expectedTitle: "Checks release gate 9001-2-checks",
					},
					releaseOperations,
				),
			).rejects.toThrow(`Checks did not start a correlated run for ${TAG} (${SHA})`);
			expect(watched, field).toEqual([]);
		}
	});

	/**
	 * Both dispatched workflows bind the controller nonce into the run title.
	 * Ref and SHA equality alone cannot distinguish simultaneous manual runs.
	 */
	it("declares nonce-bound run identity on Checks and CI", async () => {
		interface CorrelatedWorkflow {
			"run-name": string;
			on: { workflow_dispatch: { inputs: { release_nonce: { required: boolean; type: string } } } };
		}
		for (const file of ["checks.yml", "ci.yml"]) {
			const workflow = Bun.YAML.parse(
				await Bun.file(new URL(`../.github/workflows/${file}`, import.meta.url)).text(),
			) as CorrelatedWorkflow;
			expect(workflow.on.workflow_dispatch.inputs.release_nonce).toMatchObject({
				required: false,
				type: "string",
			});
			expect(workflow["run-name"]).toContain("inputs.release_nonce");
			expect(workflow["run-name"]).toContain("release gate");
		}
	});
});
