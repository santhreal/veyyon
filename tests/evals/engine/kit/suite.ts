/**
 * A benchmark as a module: a catalog of tasks, each starting its own services for one trial and
 * graded by checks over the state those services recorded.
 *
 * `defineSuite` turns a catalog into an `EvalSuite` the local-cli backend runs. The suite starts a
 * task's services before the agent starts (`prepareTrial`), stops them afterwards and writes their
 * state into the trial directory, where the agent cannot read it; `scoreTrial` grades that state
 * and the agent's answer. Grading reads files alone, so a finished run can be graded again after a
 * check is fixed.
 *
 * A suite built this way is a directory under `suites/` whose `main.ts` exports the result of
 * `defineSuite`. Nothing else registers it.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
	BackendId,
	EvalSuite,
	PreflightVerdict,
	SuiteContext,
	SuiteProvenance,
	SuiteReportContext,
	TaskDescriptor,
	TrialArtifacts,
	TrialCell,
	TrialEnvironment,
	TrialPrepareContext,
	TrialScore,
} from "../contracts";
import { listFiles } from "../io/list-files";
import { LOCAL_TRIAL_FILES } from "../run/layout";
import { catalogProblems, type KitTask } from "./catalog";
import { writeKitReport } from "./report";
import { seedOf } from "./seeded";

export interface KitSuiteSpec {
	readonly id: string;
	readonly version: string;
	readonly displayName: string;
	readonly description: string;
	/** The suite's directory; its files are the suite's provenance hash. */
	readonly sourceDir: string;
	/** Every capability a task may name, with what it means. */
	readonly capabilities: Readonly<Record<string, string>>;
	readonly tasks: readonly KitTask[];
	/** The tools every trial runs with. */
	readonly tools: readonly string[];
	/** Settings every trial runs with, under the variant's own overlay. */
	readonly settings?: Readonly<Record<string, unknown>>;
	readonly defaultTimeBudgetSec: number;
	/** Checks of the host beyond the catalog's own, such as a browser the tools need. */
	readonly preflight?: (context: SuiteContext) => Promise<PreflightVerdict>;
	/**
	 * What every trial's tools need from this host: variables and the paths they name. Resolved
	 * once per process, the first time a trial starts.
	 */
	readonly hostEnvironment?: () => Promise<HostEnvironment>;
}

export interface HostEnvironment {
	readonly env: Readonly<Record<string, string>>;
	readonly readable: readonly string[];
}

/** The file a kit trial's `finish` writes for its grader, beside the backend's own. */
export const KIT_FILES = {
	state: "state.json",
} as const;

/** The seed of one task and repeat: the arm is not part of it. */
export function trialSeed(cell: Pick<TrialCell, "task" | "repeat">): number {
	return (seedOf(cell.task) ^ Math.imul(cell.repeat + 1, 0x9e3779b1)) >>> 0;
}

export function defineSuite(spec: KitSuiteSpec): EvalSuite {
	const byId = new Map(spec.tasks.map(task => [task.id, task]));
	const requireTask = (id: string): KitTask => {
		const task = byId.get(id);
		if (!task) throw new Error(`${spec.id} has no task "${id}"`);
		return task;
	};
	const backend: BackendId = "local-cli";
	let host: Promise<HostEnvironment> | undefined;
	return {
		id: spec.id,
		version: spec.version,
		displayName: spec.displayName,
		description: spec.description,
		backend,

		async discoverTasks(): Promise<readonly string[]> {
			return spec.tasks.map(task => task.id);
		},

		async describeTask(taskId: string): Promise<TaskDescriptor> {
			const task = requireTask(taskId);
			return {
				id: task.id,
				path: null,
				timeBudgetSec: task.timeBudgetSec ?? spec.defaultTimeBudgetSec,
				instructionPath: null,
				metadata: {
					title: task.title,
					capabilities: task.capabilities,
					difficulty: task.difficulty,
					checks: task.checks.map(check => check.id),
				},
			};
		},

		async provenance(): Promise<SuiteProvenance> {
			const hash = createHash("sha256");
			for (const file of [...(await listFiles(spec.sourceDir))].sort()) {
				hash.update(file);
				hash.update("\0");
				hash.update(await fs.readFile(path.join(spec.sourceDir, file)));
				hash.update("\0");
			}
			return {
				suite: spec.id,
				version: spec.version,
				sha: hash.digest("hex"),
				metadata: { tasks: spec.tasks.length },
			};
		},

		async preflight(context: SuiteContext): Promise<PreflightVerdict> {
			const problems = catalogProblems(spec.tasks, spec.capabilities);
			if (problems.length > 0) {
				return { ok: false, reason: problems.join("; "), missingRequirements: ["valid-catalog"] };
			}
			return spec.preflight ? await spec.preflight(context) : { ok: true };
		},

		async prepareTrial(cell: TrialCell, context: TrialPrepareContext): Promise<TrialEnvironment> {
			const task = requireTask(cell.task);
			host ??= spec.hostEnvironment?.() ?? Promise.resolve({ env: {}, readable: [] });
			const { env, readable } = await host;
			const trial = await task.start({
				seed: trialSeed(cell),
				workspace: context.workspace,
				trialDir: context.trialDir,
				signal: context.signal,
			});
			return {
				instruction: trial.instruction,
				tools: spec.tools,
				settings: spec.settings,
				env,
				readable,
				async finish() {
					const state = await trial.finish();
					await fs.writeFile(path.join(context.trialDir, KIT_FILES.state), `${JSON.stringify(state, null, "\t")}\n`);
				},
			};
		},

		async scoreTrial(cell: TrialCell, artifacts: TrialArtifacts): Promise<TrialScore> {
			const task = requireTask(cell.task);
			const described = {
				...artifacts.extra,
				title: task.title,
				capabilities: task.capabilities,
				difficulty: task.difficulty,
			};
			const usage = artifacts.usage ?? null;
			if (!artifacts.trialDir) {
				return { reward: null, partial: null, error: "the trial left no directory", usage, extra: described };
			}
			let state: unknown;
			try {
				state = JSON.parse(await fs.readFile(path.join(artifacts.trialDir, KIT_FILES.state), "utf8"));
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error);
				return {
					reward: null,
					partial: null,
					error: `the trial left no readable ${KIT_FILES.state}: ${reason}`,
					usage,
					extra: described,
				};
			}
			const answer = await fs
				.readFile(path.join(artifacts.trialDir, LOCAL_TRIAL_FILES.answer), "utf8")
				.catch(() => "");
			const grade = task.grade(state, answer);
			return {
				reward: grade.reward,
				partial: grade.partial,
				error: null,
				usage,
				extra: { ...described, checks: grade.outcomes },
			};
		},

		async writeRunReport(context: SuiteReportContext): Promise<void> {
			await writeKitReport(context, spec);
		},
	};
}
