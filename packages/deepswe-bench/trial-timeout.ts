export interface TaskTimeBudgetSec {
	readonly build: number;
	readonly agent: number;
	readonly verifier: number;
	readonly missing: readonly ("build" | "verifier")[];
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function table(root: Record<string, unknown>, name: string): Record<string, unknown> | undefined {
	const value = root[name];
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

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

export function parseTaskTimeBudget(tomlText: string, taskLabel: string): TaskTimeBudgetSec {
	let parsed: Record<string, unknown>;
	try {
		parsed = Bun.TOML.parse(tomlText) as Record<string, unknown>;
	} catch (err) {
		throw new Error(`${taskLabel}: task.toml is not valid TOML: ${err}`);
	}
	return taskTimeBudget(parsed, taskLabel);
}

export function budgetedTrialTimeoutSec(budget: TaskTimeBudgetSec): number {
	return budget.build + budget.agent + budget.verifier;
}

export interface ResolvedTrialTimeout {
	readonly timeoutSec: number;
	readonly source: "task" | "override";
	readonly budgetedSec: number;
	readonly truncatesTask: boolean;
	readonly missingPhases: readonly ("build" | "verifier")[];
}

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

export function parseTrialTimeoutFlag(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`--trial-timeout must be a positive number of seconds (got ${JSON.stringify(raw)})`);
	}
	return value;
}

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
