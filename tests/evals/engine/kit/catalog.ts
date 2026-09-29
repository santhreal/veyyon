/**
 * A kit task: what one trial starts, what the agent is told, and the checks that grade it.
 */

import { type Check, type Grade, gradeChecks } from "./checks";

export type Difficulty = "easy" | "medium" | "hard" | "expert";

export const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard", "expert"];

/** What a task starts its services in. */
export interface KitTrialContext {
	/** The same for every arm on one task and repeat, and different across repeats. */
	readonly seed: number;
	/** The agent's working directory. */
	readonly workspace: string;
	/** Where the grader reads from; the agent cannot read it. */
	readonly trialDir: string;
	readonly signal?: AbortSignal;
}

/** One started trial. */
export interface KitTrial<State> {
	/** What the agent is told to do, naming the addresses of the services just started. */
	readonly instruction: string;
	/**
	 * Perform the task without an agent, through the services' own endpoints, and return the answer
	 * a correct agent would give. The suite's tests run it to prove the task can be completed and
	 * that its checks pass when it is; a trial never calls it.
	 */
	solve(): Promise<string>;
	/** Stop the services and return the state the checks read. It must survive `JSON.stringify`. */
	finish(): Promise<State>;
}

export interface KitTaskSpec<State> {
	/** Stable: runs are compared task by task on it. */
	readonly id: string;
	readonly title: string;
	/** What the task exercises, from the suite's vocabulary; reports break results down by these. */
	readonly capabilities: readonly string[];
	readonly difficulty: Difficulty;
	readonly timeBudgetSec?: number;
	readonly start: (context: KitTrialContext) => Promise<KitTrial<State>>;
	readonly checks: readonly Check<State>[];
}

/** A task with its state type erased, so one suite holds tasks over different applications. */
export interface KitTask {
	readonly id: string;
	readonly title: string;
	readonly capabilities: readonly string[];
	readonly difficulty: Difficulty;
	readonly timeBudgetSec?: number;
	readonly checks: readonly { readonly id: string; readonly description: string }[];
	start(context: KitTrialContext): Promise<KitTrial<unknown>>;
	grade(state: unknown, answer: string): Grade;
}

export function kitTask<State>(spec: KitTaskSpec<State>): KitTask {
	return {
		id: spec.id,
		title: spec.title,
		capabilities: spec.capabilities,
		difficulty: spec.difficulty,
		timeBudgetSec: spec.timeBudgetSec,
		checks: spec.checks.map(check => ({ id: check.id, description: check.description })),
		start: spec.start,
		// The state is the JSON this task's own `finish` returned and the suite wrote.
		grade: (state, answer) => gradeChecks(spec.checks, state as State, answer),
	};
}

/** Every problem with a catalog, one line each; empty when it is sound. */
export function catalogProblems(
	tasks: readonly KitTask[],
	capabilities: Readonly<Record<string, string>>,
): string[] {
	const problems: string[] = [];
	const seen = new Set<string>();
	for (const task of tasks) {
		if (!/^[a-z0-9][a-z0-9-]*$/.test(task.id)) problems.push(`${task.id}: an id is lowercase words joined by hyphens`);
		if (seen.has(task.id)) problems.push(`${task.id}: the id is used twice`);
		seen.add(task.id);
		if (task.capabilities.length === 0) problems.push(`${task.id}: names no capability`);
		for (const capability of task.capabilities) {
			if (!(capability in capabilities)) problems.push(`${task.id}: unknown capability "${capability}"`);
		}
		if (task.checks.length === 0) problems.push(`${task.id}: has no checks`);
		const checkIds = new Set<string>();
		for (const check of task.checks) {
			if (checkIds.has(check.id)) problems.push(`${task.id}: check "${check.id}" is used twice`);
			checkIds.add(check.id);
		}
	}
	return problems;
}
