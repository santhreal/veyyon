/**
 * Run planning: turn a suite plus an axis selection into the exact list of trial cells.
 *
 * The plan is computed before anything executes, so a dry run and a real run see the
 * same cells in the same order. Cell order is TASK-MAJOR with variants innermost: a
 * paired-wave scheduler that wants every variant of one task adjacent gets that for
 * free, and a bounded worker pool loses nothing by it.
 */

import type {
	EvalSuite,
	SuiteContext,
	SuiteProvenance,
	TaskDescriptor,
	TrialCell,
	Variant,
	VariantMatrixSelection,
} from "../core";
import { expandVariantMatrix } from "../core";

export class EmptyTaskSelectionError extends Error {
	readonly suiteName: string;

	constructor(suiteName: string, detail: string) {
		super(`Suite "${suiteName}" selected no tasks: ${detail}`);
		this.name = "EmptyTaskSelectionError";
		this.suiteName = suiteName;
	}
}

export class UnknownTaskError extends Error {
	readonly suiteName: string;
	readonly missing: readonly string[];

	constructor(suiteName: string, missing: readonly string[], available: number) {
		super(
			`Suite "${suiteName}" does not hold ${missing.length} requested task(s): ${missing.join(", ")}. ` +
				`It discovered ${available} task(s).`,
		);
		this.name = "UnknownTaskError";
		this.suiteName = suiteName;
		this.missing = [...missing];
	}
}

export class InvalidRepeatsError extends Error {
	constructor(repeats: number) {
		super(`repeats must be an integer >= 1, got ${repeats}.`);
		this.name = "InvalidRepeatsError";
	}
}

export interface RunPlanRequest {
	readonly suite: EvalSuite;
	readonly selection: VariantMatrixSelection;
	/** Explicit task ids. Omitted or empty means every task the suite discovers. */
	readonly tasks?: readonly string[];
	readonly repeats?: number;
	readonly context?: SuiteContext;
	/** Overrides the generated id, so a caller can name a run after its job directory. */
	readonly runId?: string;
	readonly now?: () => Date;
}

export interface RunPlan {
	readonly runId: string;
	readonly suite: EvalSuite;
	readonly provenance: SuiteProvenance;
	readonly variants: readonly Variant[];
	readonly tasks: readonly TaskDescriptor[];
	readonly cells: readonly TrialCell[];
	readonly repeats: number;
	readonly context: SuiteContext;
}

function runIdFor(suiteName: string, at: Date): string {
	const stamp = at.toISOString().replace(/[:.]/g, "-").replace("Z", "");
	return `${suiteName}-${stamp}`;
}

/**
 * Expands a selection into a concrete plan, refusing anything that would run zero trials
 * or name a task the suite does not hold.
 */
export async function buildRunPlan(request: RunPlanRequest): Promise<RunPlan> {
	const repeats = request.repeats ?? 1;
	if (!Number.isInteger(repeats) || repeats < 1) {
		throw new InvalidRepeatsError(repeats);
	}

	const suite = request.suite;
	const context: SuiteContext = request.context ?? {};
	const variants = expandVariantMatrix(request.selection);

	const discovered = await suite.discoverTasks(context);
	const requested = request.tasks && request.tasks.length > 0 ? request.tasks : discovered;

	if (requested.length === 0) {
		throw new EmptyTaskSelectionError(
			suite.name,
			request.tasks && request.tasks.length > 0
				? "the requested task list was empty"
				: "the suite discovered no tasks",
		);
	}

	if (request.tasks && request.tasks.length > 0) {
		const known = new Set(discovered);
		const missing = requested.filter(id => !known.has(id));
		if (missing.length > 0) {
			throw new UnknownTaskError(suite.name, missing, discovered.length);
		}
	}

	const tasks: TaskDescriptor[] = [];
	for (const id of requested) {
		tasks.push(await suite.describeTask(id, context));
	}

	const cells: TrialCell[] = [];
	for (let repeat = 1; repeat <= repeats; repeat++) {
		for (const task of tasks) {
			for (const variant of variants) {
				cells.push({ variant: variant.name, suite: suite.name, task: task.id, repeat });
			}
		}
	}

	const at = (request.now ?? (() => new Date()))();
	return {
		runId: request.runId ?? runIdFor(suite.name, at),
		suite,
		provenance: await suite.provenance(context),
		variants,
		tasks,
		cells,
		repeats,
		context,
	};
}

/** One line per axis, for a dry run and for the header of a real run. */
export function describeRunPlan(plan: RunPlan): string {
	const lines = [
		`suite      ${plan.suite.name} ${plan.suite.version} (backend ${plan.suite.backend})`,
		`dataset    ${plan.provenance.version}${plan.provenance.sha ? ` @ ${plan.provenance.sha}` : ""}`,
		`variants   ${plan.variants.length}: ${plan.variants.map(v => v.name).join(", ")}`,
		`models     ${[...new Set(plan.variants.map(v => v.model))].join(", ")}`,
		`tasks      ${plan.tasks.length}`,
		`repeats    ${plan.repeats}`,
		`queue      ${plan.cells.length} trial(s)`,
	];
	return lines.join("\n");
}
