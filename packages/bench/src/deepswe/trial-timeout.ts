/**
 * How long a single DeepSWE trial is allowed to run.
 *
 * The bench wraps one `pier run` in one timer. That single run spans three
 * phases the task itself budgets separately in `task.toml`: building the
 * environment, running the agent, and running the verifier. A flat harness
 * timeout that ignores those numbers does not shorten the task, it truncates
 * it, and the truncation is not neutral. Any arm that is slower per turn eats
 * more truncations than a fast one, so a flat timeout quietly converts "this
 * arm spends more wall clock per turn" into "this arm solves fewer tasks",
 * which is a different claim entirely.
 *
 * So the default is derived per task from what the task granted, and the flag
 * stays as an explicit override for an operator who knowingly wants a shorter
 * run. Nothing here silently substitutes a number: a task with no agent budget
 * throws, and an override that cuts into a task's own budget is reported to the
 * caller so the run can say so out loud.
 */

/**
 * The three `task.toml` budgets a single `pier run` spans, in seconds.
 *
 * Named for the phases rather than the TOML keys because the keys live in three
 * different tables (`[environment].build_timeout_sec`, `[agent].timeout_sec`,
 * `[verifier].timeout_sec`) and a reader should not have to hold that mapping.
 */
export interface TaskTimeBudgetSec {
	/** `[environment].build_timeout_sec`: image build, before the agent starts. */
	readonly build: number;
	/** `[agent].timeout_sec`: what the task grants the agent itself. */
	readonly agent: number;
	/** `[verifier].timeout_sec`: grading, after the agent stops. */
	readonly verifier: number;
	/**
	 * Phases the task declared no budget for. Summing a missing phase as zero
	 * would under-budget the trial by exactly the amount nobody wrote down, so
	 * the omission travels with the number instead of being absorbed into it.
	 */
	readonly missing: readonly ("build" | "verifier")[];
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function table(root: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
	const value = root[name];
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Read the three phase budgets out of an already-parsed `task.toml`.
 *
 * Throws when `[agent].timeout_sec` is absent or non-positive: that is the one
 * number this whole mechanism exists to honour, and inventing a replacement for
 * it would reintroduce the flat-default bug one layer down.
 */
export function taskTimeBudget(parsed: Record<string, unknown>, taskLabel: string): TaskTimeBudgetSec {
	const agent = positiveNumber(table(parsed, "agent")?.timeout_sec);
	if (agent === undefined) {
		throw new Error(
			`${taskLabel}: task.toml has no positive [agent] timeout_sec, so the trial has no budget to honour; ` +
				`pass --trial-timeout <seconds> to choose one explicitly`,
		);
	}
	const build = positiveNumber(table(parsed, "environment")?.build_timeout_sec);
	const verifier = positiveNumber(table(parsed, "verifier")?.timeout_sec);
	const missing: ("build" | "verifier")[] = [];
	if (build === undefined) missing.push("build");
	if (verifier === undefined) missing.push("verifier");
	return { build: build ?? 0, agent, verifier: verifier ?? 0, missing };
}

/** Parse a `task.toml` and extract its phase budgets. */
export function parseTaskTimeBudget(tomlText: string, taskLabel: string): TaskTimeBudgetSec {
	let parsed: Record<string, unknown>;
	try {
		parsed = Bun.TOML.parse(tomlText) as Record<string, unknown>;
	} catch (err) {
		throw new Error(`${taskLabel}: task.toml is not valid TOML: ${err}`);
	}
	return taskTimeBudget(parsed, taskLabel);
}

/**
 * Wall clock the task granted the whole trial: every phase the one timer spans.
 *
 * Not just the agent budget. The timer starts before the image build and is
 * still running during verification, so charging the agent's budget alone would
 * kill trials mid-grade and record them as agent failures.
 */
export function budgetedTrialTimeoutSec(budget: TaskTimeBudgetSec): number {
	return budget.build + budget.agent + budget.verifier;
}

/** What {@link resolveTrialTimeout} decided, and why. */
export interface ResolvedTrialTimeout {
	/** Seconds the harness will allow this trial. */
	readonly timeoutSec: number;
	/** `"task"` when derived from `task.toml`, `"override"` when the flag won. */
	readonly source: "task" | "override";
	/** The task's own budget, kept so callers can report what an override gave up. */
	readonly budgetedSec: number;
	/**
	 * True when an explicit override is SHORTER than the task's own budget, i.e.
	 * this trial may be cut off while the task still considers it running. The
	 * caller must surface this; a silent truncation is the original bug.
	 */
	readonly truncatesTask: boolean;
	/** Phases with no declared budget, forwarded from {@link TaskTimeBudgetSec}. */
	readonly missingPhases: readonly ("build" | "verifier")[];
}

/**
 * Decide one trial's timeout: the explicit override if given, else the task's
 * own summed budget.
 */
export function resolveTrialTimeout(budget: TaskTimeBudgetSec, overrideSec?: number): ResolvedTrialTimeout {
	const budgetedSec = budgetedTrialTimeoutSec(budget);
	if (overrideSec === undefined) {
		return {
			timeoutSec: budgetedSec,
			source: "task",
			budgetedSec,
			truncatesTask: false,
			missingPhases: budget.missing,
		};
	}
	return {
		timeoutSec: overrideSec,
		source: "override",
		budgetedSec,
		truncatesTask: overrideSec < budgetedSec,
		missingPhases: budget.missing,
	};
}

/**
 * Parse `--trial-timeout`.
 *
 * `undefined` means "not passed", which is what makes the per-task default
 * reachable. A malformed value is rejected rather than rounded down to a
 * default, because a typo that silently becomes 900 is the failure mode this
 * whole module is about.
 */
export function parseTrialTimeoutFlag(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`--trial-timeout must be a positive number of seconds (got ${JSON.stringify(raw)})`);
	}
	return value;
}

/**
 * The one-line warning a run prints when an override truncates tasks.
 *
 * Returns `undefined` when nothing is truncated, so the caller's control flow is
 * "print it if there is one" rather than a condition restated at the call site.
 */
export function truncationWarning(resolved: ReadonlyMap<string, ResolvedTrialTimeout>): string | undefined {
	const truncated = [...resolved.entries()].filter(([, r]) => r.truncatesTask);
	if (truncated.length === 0) return undefined;
	const worst = truncated.reduce((a, b) => (a[1].budgetedSec > b[1].budgetedSec ? a : b));
	return (
		`warning: --trial-timeout ${worst[1].timeoutSec}s truncates ${truncated.length} of ${resolved.size} ` +
		`task(s) below their own budget (largest: ${worst[0]} budgets ${worst[1].budgetedSec}s). ` +
		`Trials killed by the harness are counted separately from agent failures, and a reward or ` +
		`efficiency delta between arms with different timeout counts is not attributable.`
	);
}
