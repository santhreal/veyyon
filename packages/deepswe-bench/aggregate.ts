/**
 * Pure result aggregation and report rendering for the DeepSWE bench.
 *
 * This lives apart from run.ts on purpose: run.ts is the entrypoint and ends with
 * a top-level `await main()`, so importing it to unit-test the math would launch a
 * benchmark. Everything here is a pure function of already-collected results, so a
 * test can feed it fixtures and assert exact numbers. run.ts imports {@link
 * ArmResult} and {@link renderReport} from here.
 *
 * The statistical core is {@link summarizeCell}: with `--repeats K`, an
 * (arm, task) cell holds up to K samples, and a single number cannot describe K
 * stochastic runs. A cell is summarized as a pass RATE with a binomial standard
 * error, which is what lets a reader tell a real arm effect from run-to-run noise.
 */

/**
 * The job name is the single identifier for a container run, a config file, and a
 * jobs/ subdirectory, so its format lives in exactly this pair of functions and
 * nowhere else. A repeat suffix (`__r<n>`) is appended only when a cell is sampled
 * more than once; a single-sample run keeps the historic `arm__task` name so runs
 * produced before --repeats existed still reaggregate. The scheme relies on two
 * facts about the inputs: arm names never contain `__`, and DeepSWE task names are
 * hyphenated (never `__`). So the FIRST `__` splits arm from the rest, and a
 * trailing `__r<digits>` is the repeat index. {@link parseJobName} is the exact
 * inverse of {@link jobNameOf}; the round-trip is what keeps reaggregate from
 * mis-attributing a sample to the wrong task or repeat.
 */
export function jobNameOf(arm: string, task: string, repeat: number, repeats: number): string {
	return repeats > 1 ? `${arm}__${task}__r${repeat}` : `${arm}__${task}`;
}

/** Inverse of {@link jobNameOf}: recover (arm, task, repeat) from a job name. */
export function parseJobName(jobName: string): { arm: string; task: string; repeat: number } {
	const sep = jobName.indexOf("__");
	const arm = jobName.slice(0, sep);
	let task = jobName.slice(sep + 2);
	let repeat = 0;
	const m = task.match(/__r(\d+)$/);
	if (m) {
		repeat = Number(m[1]);
		task = task.slice(0, m.index);
	}
	return { arm, task, repeat };
}

export interface ArmResult {
	arm: string;
	task: string;
	/** 0-based sample index within an (arm, task) cell; 0 when --repeats is 1. */
	repeat: number;
	reward: number | null;
	partial: number | null;
	f2p: number | null;
	p2p: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheTokens: number | null;
	costUsd: number | null;
	agentSeconds: number | null;
	argotLoadCalls: number | null;
	assistantMsgsWithSigil: number | null;
	toolCalls: Record<string, number> | null;
	error: string | null;
}

/**
 * The summary of one group of samples (a whole arm, or a single (arm, task) cell).
 * Every mean is over the OK samples only (errors are excluded from reward/token
 * math but counted in {@link errors}), because a container that never produced a
 * trial has no reward to average and would drag a mean toward zero as if the agent
 * had failed the task, which it did not.
 */
export interface CellSummary {
	/** All attempts in the group, including errored ones. */
	total: number;
	/** Attempts that errored (no trial result). */
	errors: number;
	/** OK attempts (total - errors); the denominator for every rate and mean. */
	n: number;
	/** OK attempts with reward exactly 1. */
	passes: number;
	/** passes / n, or null when n is 0. */
	passRate: number | null;
	/**
	 * Binomial standard error of {@link passRate}: sqrt(p*(1-p)/n). This is the
	 * headline uncertainty number: two arms whose pass rates differ by less than a
	 * couple of standard errors are not distinguishable at this sample count, and
	 * the report prints it so a reader does not over-read noise. Null when n is 0.
	 */
	stdErr: number | null;
	meanReward: number | null;
	meanPartial: number | null;
	meanOutputTokens: number | null;
	meanCostUsd: number | null;
	sumOutputTokens: number;
	sumCostUsd: number;
	sumInputTokens: number;
	sumCacheTokens: number;
	sumAgentSeconds: number;
}

function mean(values: Array<number | null>): number | null {
	const nums = values.filter((v): v is number => v !== null && v !== undefined);
	if (nums.length === 0) return null;
	return nums.reduce((a, v) => a + v, 0) / nums.length;
}

/**
 * Reduce a group of samples to a {@link CellSummary}. Pure: same input, same
 * output, no IO. Used for both the per-arm rollup (all of an arm's samples) and
 * each per-task cell (one arm, one task, all repeats).
 */
export function summarizeCell(rows: readonly ArmResult[]): CellSummary {
	const ok = rows.filter(r => !r.error);
	const n = ok.length;
	const passes = ok.filter(r => r.reward === 1).length;
	const passRate = n > 0 ? passes / n : null;
	const stdErr = passRate === null ? null : Math.sqrt((passRate * (1 - passRate)) / n);
	const sum = (f: (r: ArmResult) => number | null) => ok.reduce((a, r) => a + (f(r) ?? 0), 0);
	return {
		total: rows.length,
		errors: rows.length - n,
		n,
		passes,
		passRate,
		stdErr,
		meanReward: mean(ok.map(r => r.reward)),
		meanPartial: mean(ok.map(r => r.partial)),
		meanOutputTokens: mean(ok.map(r => r.outputTokens)),
		meanCostUsd: mean(ok.map(r => r.costUsd)),
		sumOutputTokens: sum(r => r.outputTokens),
		sumCostUsd: sum(r => r.costUsd),
		sumInputTokens: sum(r => r.inputTokens),
		sumCacheTokens: sum(r => r.cacheTokens),
		sumAgentSeconds: sum(r => r.agentSeconds),
	};
}

function fmt(n: number | null, digits = 0): string {
	if (n === null || n === undefined) return "—";
	return digits > 0 ? n.toFixed(digits) : String(Math.round(n));
}

/** A pass rate rendered with its standard error, e.g. `0.67 ±0.14 (4/6)`. */
function fmtRate(s: CellSummary): string {
	if (s.passRate === null) return "—";
	const se = s.stdErr === null ? "" : ` ±${s.stdErr.toFixed(2)}`;
	return `${s.passRate.toFixed(2)}${se} (${s.passes}/${s.n})`;
}

/**
 * Render the full markdown report. `repeats` is passed so the header can state the
 * sample count; it is not re-derived from the rows, so an all-errored run still
 * reports the intended repeat count rather than collapsing to 1.
 */
export function renderReport(results: readonly ArmResult[], model: string, nowIso: string, repeats = 1): string {
	const arms = [...new Set(results.map(r => r.arm))];
	const tasks = [...new Set(results.map(r => r.task))];
	const cell = (arm: string, task: string) => results.filter(r => r.arm === arm && r.task === task);
	const lines: string[] = [];
	lines.push(`# DeepSWE bench — ${nowIso}`);
	lines.push("");
	lines.push(`Model: \`${model}\`. Tasks: ${tasks.length}. Repeats/cell: ${repeats}. Arms: ${arms.join(", ")}.`);
	lines.push("");
	lines.push("## Per arm totals");
	lines.push("");
	lines.push(
		"| arm | samples | pass rate ±se | mean reward | mean partial | input tok | output tok | cache tok | cost USD | agent wall |",
	);
	lines.push("|---|---|---|---|---|---|---|---|---|---|");
	for (const arm of arms) {
		const s = summarizeCell(results.filter(r => r.arm === arm));
		const samples = s.errors > 0 ? `${s.n} (+${s.errors} err)` : String(s.n);
		lines.push(
			`| ${arm} | ${samples} | ${fmtRate(s)} | ${fmt(s.meanReward, 2)} | ${fmt(s.meanPartial, 2)} | ` +
				`${fmt(s.sumInputTokens)} | ${fmt(s.sumOutputTokens)} | ${fmt(s.sumCacheTokens)} | ` +
				`$${s.sumCostUsd.toFixed(3)} | ${fmt(s.sumAgentSeconds)}s |`,
		);
	}
	lines.push("");
	lines.push("## Per task");
	lines.push("");
	lines.push(`| task | ${arms.map(a => `${a}: pass | ${a}: mean out tok | ${a}: mean cost`).join(" | ")} |`);
	lines.push(`|---|${arms.map(() => "---|---|---|").join("")}`);
	for (const task of tasks) {
		const cells = arms.flatMap(a => {
			const s = summarizeCell(cell(a, task));
			if (s.total === 0) return ["—", "—", "—"];
			if (s.n === 0) return ["ERR", "—", "—"];
			return [fmtRate(s), fmt(s.meanOutputTokens), s.meanCostUsd === null ? "—" : `$${s.meanCostUsd.toFixed(3)}`];
		});
		lines.push(`| ${task} | ${cells.join(" | ")} |`);
	}
	const probeArms = arms.filter(a => results.some(r => r.arm === a && (r.argotLoadCalls ?? 0) > 0));
	if (probeArms.length > 0) {
		lines.push("");
		lines.push("## Argot probes");
		lines.push("");
		lines.push("| arm | task | repeat | argot_load calls | assistant msgs containing § |");
		lines.push("|---|---|---|---|---|");
		for (const r of results.filter(x => probeArms.includes(x.arm))) {
			lines.push(
				`| ${r.arm} | ${r.task} | ${r.repeat} | ${fmt(r.argotLoadCalls)} | ${fmt(r.assistantMsgsWithSigil)} |`,
			);
		}
	}
	const allTools = [...new Set(results.flatMap(r => Object.keys(r.toolCalls ?? {})))].sort();
	if (allTools.length > 0) {
		lines.push("");
		lines.push("## Tool Call Distribution (per arm totals)");
		lines.push("");
		lines.push(`| arm | ${allTools.join(" | ")} |`);
		lines.push(`|---|${allTools.map(() => "---|").join("")}`);
		for (const arm of arms) {
			const rows = results.filter(r => r.arm === arm && !r.error);
			const cells = allTools.map(t => fmt(rows.reduce((acc, r) => acc + (r.toolCalls?.[t] ?? 0), 0)));
			lines.push(`| ${arm} | ${cells.join(" | ")} |`);
		}
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}
