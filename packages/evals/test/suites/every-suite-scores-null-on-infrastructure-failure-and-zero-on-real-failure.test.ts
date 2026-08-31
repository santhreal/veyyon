/**
 * WHY THIS SUITE EXISTS:
 *
 * An evaluation harness has one load-bearing duty: score honesty.
 * A broken fixture, a missing trial directory, an unreadable verifier file,
 * or an infrastructure crash must NEVER be scored as `reward: 0` (which is
 * indistinguishable from an agent that ran fairly and solved 0% of the task).
 *
 * This suite enforces that:
 * 1. Every registered EvalSuite in the registry at runtime is dynamically enumerated.
 * 2. An infrastructure failure (missing fixture, missing trialDir, unreadable reward artifact, crashed execution)
 *    produces `reward === null` with a non-empty `error` string.
 * 3. A genuine zero-score trial (where the agent executed properly against valid fixtures but failed the verifier)
 *    produces `reward === 0` with `error === null`.
 * 4. Any newly registered suite without an explicit test driver fails closed (uncovered set must be empty).
 *
 * WHAT THIS SUITE DOES NOT CATCH:
 * Numerical errors inside a task's third-party verifier test suite (e.g. an upstream test bug inside a benchmark task).
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TrialArtifacts, TrialCell } from "../../engine/contracts";
import { suites } from "../../engine/loaded-members";
import { internalScratchDir } from "../../engine/package-paths";

function createScratchDir(prefix: string): string {
	const base = internalScratchDir();
	fs.mkdirSync(base, { recursive: true });
	return fs.mkdtempSync(path.join(base, prefix));
}

interface SuiteScoreDriver {
	createInfrastructureFailureArtifacts(scratchDir: string): Promise<{ cell: TrialCell; artifacts: TrialArtifacts }>;
	createGenuineZeroArtifacts(scratchDir: string): Promise<{ cell: TrialCell; artifacts: TrialArtifacts }>;
}

const SUITE_SCORE_DRIVERS: Record<string, SuiteScoreDriver> = {
	"typescript-edit": {
		async createInfrastructureFailureArtifacts(scratchDir: string) {
			const trialDir = path.join(scratchDir, "infra-fail-trial");
			fs.mkdirSync(trialDir, { recursive: true });
			// Actual dir exists but task metadata expectedDir does not exist or has missing files
			return {
				cell: {
					suite: "typescript-edit",
					variant: "baseline",
					task: "nonexistent-task-fixture",
					repeat: 0,
				},
				artifacts: {
					trialDir,
					filePaths: {},
				},
			};
		},
		async createGenuineZeroArtifacts(scratchDir: string) {
			// Valid task with incorrect edited content
			const trialDir = path.join(scratchDir, "zero-trial");
			fs.mkdirSync(trialDir, { recursive: true });
			// Create the file but with wrong content
			fs.writeFileSync(path.join(trialDir, "index.ts"), "const wrong = 123;\n", "utf8");
			return {
				cell: {
					suite: "typescript-edit",
					variant: "baseline",
					task: "access-remove-optional-chain-001",
					repeat: 0,
				},
				artifacts: {
					trialDir,
					filePaths: {
						"index.ts": path.join(trialDir, "index.ts"),
					},
				},
			};
		},
	},

	"terminal-bench": {
		async createInfrastructureFailureArtifacts(scratchDir: string) {
			const trialDir = path.join(scratchDir, "tb-infra-fail");
			fs.mkdirSync(trialDir, { recursive: true });
			// No reward file present
			return {
				cell: {
					suite: "terminal-bench",
					variant: "baseline",
					task: "bun-sourcemap-leak",
					repeat: 0,
				},
				artifacts: {
					trialDir,
					filePaths: {},
				},
			};
		},
		async createGenuineZeroArtifacts(scratchDir: string) {
			const trialDir = path.join(scratchDir, "tb-zero-trial");
			const verifierDir = path.join(trialDir, "verifier");
			fs.mkdirSync(verifierDir, { recursive: true });
			const rewardPath = path.join(verifierDir, "reward.json");
			fs.writeFileSync(rewardPath, JSON.stringify({ reward: 0.0 }), "utf8");
			return {
				cell: {
					suite: "terminal-bench",
					variant: "baseline",
					task: "bun-sourcemap-leak",
					repeat: 0,
				},
				artifacts: {
					trialDir,
					filePaths: {
						"verifier/reward.json": rewardPath,
					},
				},
			};
		},
	},

	"deep-swe": {
		async createInfrastructureFailureArtifacts(scratchDir: string) {
			// Missing trialDir / container crash
			return {
				cell: {
					suite: "deep-swe",
					variant: "baseline",
					task: "smoke-task",
					repeat: 0,
				},
				artifacts: {
					trialDir: path.join(scratchDir, "nonexistent-job-dir", "task__xyz"),
					filePaths: {},
					extra: { error: "Container exit 137: OOM killed" },
				},
			};
		},
		async createGenuineZeroArtifacts(scratchDir: string) {
			const jobDir = path.join(scratchDir, "job-zero");
			const trialDir = path.join(jobDir, "task__001");
			const verifierDir = path.join(trialDir, "verifier");
			fs.mkdirSync(verifierDir, { recursive: true });
			fs.writeFileSync(
				path.join(trialDir, "result.json"),
				JSON.stringify({
					trial_name: "task__001",
					verifier_result: {
						rewards: { reward: 0.0, partial: 0.0, f2p: 0.0, p2p: 0.0 },
					},
				}),
				"utf8",
			);
			return {
				cell: {
					suite: "deep-swe",
					variant: "baseline",
					task: "smoke-task",
					repeat: 0,
				},
				artifacts: {
					trialDir,
					filePaths: {
						"result.json": path.join(trialDir, "result.json"),
					},
				},
			};
		},
	},
};

describe("Score Honesty — every registered suite maps infrastructure failures to reward: null", () => {
	const registeredSuites = suites.list();

	it("covers every registered suite from the registry without gaps", () => {
		const suiteNames = registeredSuites.map(s => s.id).sort();
		const drivenNames = Object.keys(SUITE_SCORE_DRIVERS).sort();
		const uncovered = suiteNames.filter(name => !drivenNames.includes(name));

		expect(uncovered).toEqual([]);
		expect(registeredSuites.length).toBeGreaterThanOrEqual(3);
	});

	for (const suite of registeredSuites) {
		describe(`Suite: ${suite.id}`, () => {
			const driver = SUITE_SCORE_DRIVERS[suite.id];

			it(`reports reward: null and non-empty error on infrastructure failure for ${suite.id}`, async () => {
				expect(driver).toBeDefined();
				const scratch = createScratchDir(`score-infra-${suite.id}-`);
				try {
					const { cell, artifacts } = await driver!.createInfrastructureFailureArtifacts(scratch);
					const score = await suite.scoreTrial(cell, artifacts);

					expect(score.reward).toBeNull();
					expect(score.error).not.toBeNull();
					expect(typeof score.error).toBe("string");
					expect(score.error!.trim().length).toBeGreaterThan(0);
				} finally {
					try {
						fs.rmSync(scratch, { recursive: true, force: true });
					} catch {
						/* ignore */
					}
				}
			});

			it(`reports reward: 0 and error: null on genuine task failure for ${suite.id}`, async () => {
				expect(driver).toBeDefined();
				const scratch = createScratchDir(`score-zero-${suite.id}-`);
				try {
					const { cell, artifacts } = await driver!.createGenuineZeroArtifacts(scratch);
					const score = await suite.scoreTrial(cell, artifacts);

					expect(score.reward).toBe(0);
					expect(score.error).toBeNull();
				} finally {
					try {
						fs.rmSync(scratch, { recursive: true, force: true });
					} catch {
						/* ignore */
					}
				}
			});
		});
	}
});
