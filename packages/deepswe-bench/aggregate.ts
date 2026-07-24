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
 * stochastic runs. A cell is summarized as a pass RATE with a 95% Wilson
 * confidence interval (see {@link wilsonInterval}), which is what lets a reader
 * tell a real arm effect from run-to-run noise without being fooled by the
 * zero-width standard error a boundary cell produces.
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

/**
 * Pick `limit` tasks spread EVENLY across the sorted task set, for a smoke/debug
 * run that cannot afford the full suite.
 *
 * The obvious `sorted.slice(0, limit)` is unsound as a sample: DeepSWE task names
 * are repo-prefixed (`astropy__...`, `django__...`), so the alphabetically-first
 * N cluster on the first repo or two, and a pass rate measured over them is not an
 * estimate of the pass rate over the whole suite — it silently benches a biased
 * slice. An even stride across the sorted list spans the whole task space instead,
 * so a limited run is a representative subsample of the full one.
 *
 * The stride is fully deterministic (no RNG), so the same `limit` always selects
 * the same tasks and a limited run stays reproducible and reaggregatable. Returns
 * the full set (a copy) when `limit` is undefined or at least the set size, and the
 * empty set when `limit <= 0`.
 */
export function selectTasks(sorted: readonly string[], limit: number | undefined): string[] {
	if (limit === undefined || limit >= sorted.length) return [...sorted];
	if (limit <= 0) return [];
	const out: string[] = [];
	for (let i = 0; i < limit; i++) {
		// i/limit walks [0,1) in `limit` even steps; scaling by the set size spreads
		// the picks across the whole sorted range instead of clustering at the head.
		out.push(sorted[Math.floor((i * sorted.length) / limit)] as string);
	}
	return out;
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
	 * Binomial normal-approximation standard error of {@link passRate}:
	 * sqrt(p*(1-p)/n). A convenient point measure of spread, kept for downstream
	 * analysis, but NOT the displayed interval: at the boundaries it is degenerate
	 * (all-pass or all-fail gives exactly 0, falsely implying certainty), and on a
	 * SWE bench with small K those boundary cells are common. The report shows the
	 * Wilson interval instead (see {@link wilsonLow}). Null when n is 0.
	 */
	stdErr: number | null;
	/**
	 * Lower / upper bound of the Wilson score 95% confidence interval for
	 * {@link passRate}. This is the honest uncertainty the report prints: unlike the
	 * normal-approximation {@link stdErr}, it never collapses to a zero-width claim
	 * at the boundary — 3 of 3 passes yields roughly [0.44, 1.0], not [1.0, 1.0], so
	 * a reader cannot mistake a lucky small sample for a certain result. Two arms
	 * whose Wilson intervals overlap are not distinguishable at this sample count.
	 * Null when n is 0.
	 */
	wilsonLow: number | null;
	wilsonHigh: number | null;
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
 * The sampling temperature the bench pins for every arm that does not set its own.
 *
 * 0 means greedy/deterministic decoding. The bench pins it, rather than inheriting
 * veyyon's own default of -1 ("use the provider default"), for two reasons that
 * matter for an eval set meant to be iterated on for a long time:
 *
 *  1. Interpretability of `--repeats`. At temperature 0 the only run-to-run
 *     variation is genuine provider nondeterminism, not sampling spread, so a small
 *     K estimates each arm's pass rate with the tightest interval and a real arm
 *     effect is detectable with fewer samples.
 *  2. Longitudinal comparability. A provider default can change silently between two
 *     runs (a model or provider update), which would make two runs non-comparable
 *     with nothing recording the drift. A pinned, stamped value cannot drift
 *     unnoticed.
 *
 * At temperature 0 the decode is greedy, so top-p / top-k are irrelevant; pinning
 * temperature alone fully determines the sampling regime. An individual arm MAY
 * still set its own temperature for a deliberate temperature-as-independent-variable
 * experiment (see {@link effectiveTemperature}), and that override is recorded.
 */
export const PINNED_TEMPERATURE = 0;

/**
 * The temperature one arm actually runs at: the arm's own `temperature` when it
 * sets a real (non-negative) one — a deliberate temperature-as-IV experiment —
 * otherwise {@link PINNED_TEMPERATURE}. A value below 0 in the config means "use the
 * provider default", which is exactly the silent-drift regime the bench refuses to
 * leave in place, so it is treated as unset and the pinned value wins. Pure so the
 * runner and the results.json stamp agree by construction.
 */
export function effectiveTemperature(config: unknown, pinned: number = PINNED_TEMPERATURE): number {
	if (config !== null && typeof config === "object" && "temperature" in config) {
		const t = (config as { temperature: unknown }).temperature;
		if (typeof t === "number" && Number.isFinite(t) && t >= 0) return t;
	}
	return pinned;
}

/** z for a two-sided 95% interval (standard normal 0.975 quantile). */
const Z_95 = 1.959963984540054;

/**
 * Wilson score confidence interval for a binomial proportion (passes out of n).
 * Returns the interval that is honest at the boundaries where the normal
 * approximation is not: with k = n (or k = 0) it still reports real width instead
 * of collapsing to a point, which is exactly the small-sample, near-0/near-1 regime
 * a task-level bench spends most of its time in. Bounds are clamped to [0, 1].
 * Returns null bounds when n is 0 (no attempts to estimate from).
 */
export function wilsonInterval(
	passes: number,
	n: number,
	z: number = Z_95,
): { low: number | null; high: number | null } {
	if (n <= 0) return { low: null, high: null };
	const p = passes / n;
	const z2 = z * z;
	const denom = 1 + z2 / n;
	const center = (p + z2 / (2 * n)) / denom;
	const halfWidth = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
	return {
		low: Math.max(0, center - halfWidth),
		high: Math.min(1, center + halfWidth),
	};
}

/**
 * Two-sided exact sign-test p-value for a paired comparison: given `wins` tasks
 * where arm B beat arm A and `losses` where A beat B (ties excluded), the
 * probability, under the null that B and A are equally good, of a win/loss split
 * at least this lopsided in either direction.
 *
 * This is the honest arm-vs-arm test. Comparing two arms' independent Wilson
 * intervals for overlap throws away the fact that BOTH arms ran the SAME tasks:
 * task difficulty is the dominant source of variance, and pairing by task removes
 * it, so the paired test has far more power. The sign test is chosen over a
 * normal-approximation paired t because it is exact and makes no distributional
 * assumption — it cannot understate uncertainty at the small task counts a bench
 * usually runs, which is the same failure mode the Wilson interval fixes for a
 * single cell. Computed from the Binomial(n, 0.5) CDF with an iterative PMF, so
 * there is no overflow even at 100+ tasks and no floating factorial.
 *
 * Returns 1 when there are no decisive tasks (all ties): no evidence either way.
 */
export function signTestPValue(wins: number, losses: number): number {
	const n = wins + losses;
	if (n <= 0) return 1;
	const k = Math.min(wins, losses);
	// Cumulative P(X <= k) for X ~ Binomial(n, 0.5), built from pmf(0) = 0.5^n and
	// the ratio pmf(i) = pmf(i-1) * (n-i+1)/i. Stable and exact-in-spirit.
	let pmf = 0.5 ** n;
	let cdf = pmf;
	for (let i = 1; i <= k; i++) {
		pmf *= (n - i + 1) / i;
		cdf += pmf;
	}
	return Math.min(1, 2 * cdf);
}

/** One arm-vs-arm paired comparison over the tasks both arms ran. */
export interface ArmDelta {
	/** Reference arm (the "from" side of the delta). */
	armA: string;
	/** Candidate arm (the "to" side); {@link meanDelta} is B minus A. */
	armB: string;
	/** Tasks with at least one OK (non-errored) sample in BOTH arms — the paired unit count. */
	nTasks: number;
	/** Mean over paired tasks of (passRate_B - passRate_A). Positive = B better. Null when nTasks is 0. */
	meanDelta: number | null;
	/**
	 * 95% CI for {@link meanDelta} from the per-task deltas (normal approximation,
	 * z * sd/sqrt(nTasks)). An effect-size aid, secondary to {@link signTestP}; at a
	 * small nTasks read the sign test, not this. Null when nTasks < 2 (no spread to
	 * estimate).
	 */
	ciLow: number | null;
	ciHigh: number | null;
	/** Tasks where B's pass rate exceeded A's. */
	wins: number;
	/** Tasks where A's pass rate exceeded B's. */
	losses: number;
	/** Tasks where the two pass rates were equal. */
	ties: number;
	/** Two-sided exact sign-test p-value over wins/losses (see {@link signTestPValue}). */
	signTestP: number;
}

/**
 * Every unordered arm pair, compared PAIRED by task. For each pair, a task counts
 * only when both arms produced at least one OK sample for it (an all-errored cell
 * cannot be paired), and the per-task delta is the difference of the two cells'
 * pass rates. Pure and deterministic: arms are compared in first-seen order, so the
 * same results always yield the same table. This is what lets the report state
 * whether B actually beat A instead of asking the reader to eyeball two overlapping
 * independent intervals.
 */
export function pairwiseArmDeltas(results: readonly ArmResult[]): ArmDelta[] {
	const arms = [...new Set(results.map(r => r.arm))];
	const tasks = [...new Set(results.map(r => r.task))];
	const rateOf = (arm: string, task: string): number | null =>
		summarizeCell(results.filter(r => r.arm === arm && r.task === task)).passRate;
	const out: ArmDelta[] = [];
	for (let i = 0; i < arms.length; i++) {
		for (let j = i + 1; j < arms.length; j++) {
			const armA = arms[i] as string;
			const armB = arms[j] as string;
			const deltas: number[] = [];
			let wins = 0;
			let losses = 0;
			let ties = 0;
			for (const task of tasks) {
				const a = rateOf(armA, task);
				const b = rateOf(armB, task);
				if (a === null || b === null) continue; // unpaired: one arm has no OK sample here
				const d = b - a;
				deltas.push(d);
				if (d > 0) wins++;
				else if (d < 0) losses++;
				else ties++;
			}
			const nTasks = deltas.length;
			const meanDelta = nTasks > 0 ? deltas.reduce((s, d) => s + d, 0) / nTasks : null;
			let ciLow: number | null = null;
			let ciHigh: number | null = null;
			if (nTasks >= 2 && meanDelta !== null) {
				const variance = deltas.reduce((s, d) => s + (d - meanDelta) ** 2, 0) / (nTasks - 1);
				const se = Math.sqrt(variance / nTasks);
				ciLow = meanDelta - Z_95 * se;
				ciHigh = meanDelta + Z_95 * se;
			}
			out.push({
				armA,
				armB,
				nTasks,
				meanDelta,
				ciLow,
				ciHigh,
				wins,
				losses,
				ties,
				signTestP: signTestPValue(wins, losses),
			});
		}
	}
	return out;
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
	const wilson = wilsonInterval(passes, n);
	const sum = (f: (r: ArmResult) => number | null) => ok.reduce((a, r) => a + (f(r) ?? 0), 0);
	return {
		total: rows.length,
		errors: rows.length - n,
		n,
		passes,
		passRate,
		stdErr,
		wilsonLow: wilson.low,
		wilsonHigh: wilson.high,
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

/**
 * A pass rate rendered with its 95% Wilson confidence interval, e.g.
 * `0.67 [0.30–0.90] (4/6)`. The interval is the Wilson score interval, not
 * `passRate ± stdErr`: the normal-approximation error collapses to a zero-width
 * `±0.00` at an all-pass or all-fail cell (`3/3` → `1.00 ±0.00`), which reads as
 * false certainty. Boundary cells are common on a SWE bench, so the report shows
 * the Wilson bounds — `3/3` becomes `1.00 [0.44–1.00]`, honestly wide.
 */
function fmtRate(s: CellSummary): string {
	if (s.passRate === null) return "—";
	const ci =
		s.wilsonLow === null || s.wilsonHigh === null ? "" : ` [${s.wilsonLow.toFixed(2)}–${s.wilsonHigh.toFixed(2)}]`;
	return `${s.passRate.toFixed(2)}${ci} (${s.passes}/${s.n})`;
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
		"| arm | samples | pass rate [95% CI] | mean reward | mean partial | input tok | output tok | cache tok | cost USD | agent wall |",
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
	if (arms.length >= 2) {
		lines.push("");
		lines.push("## Arm comparison (paired by task)");
		lines.push("");
		lines.push(
			"Δ pass rate is arm B minus arm A, averaged over tasks both arms ran. The verdict is a two-sided exact " +
				"sign test over per-task wins/losses (ties excluded); it uses the paired structure, so it has far more " +
				"power than comparing the two arms' independent intervals above. The Δ 95% CI is a normal-approximation " +
				"effect-size aid — at a small task count, trust the sign test.",
		);
		lines.push("");
		lines.push("| A → B | paired tasks | Δ pass rate | Δ 95% CI | W-L-T | sign-test p | verdict |");
		lines.push("|---|---|---|---|---|---|---|");
		for (const d of pairwiseArmDeltas(results)) {
			const delta = d.meanDelta === null ? "—" : (d.meanDelta >= 0 ? "+" : "") + d.meanDelta.toFixed(3);
			const ci =
				d.ciLow === null || d.ciHigh === null
					? "—"
					: `[${(d.ciLow >= 0 ? "+" : "") + d.ciLow.toFixed(3)}, ${(d.ciHigh >= 0 ? "+" : "") + d.ciHigh.toFixed(3)}]`;
			const decisive = d.wins + d.losses > 0 && d.signTestP < 0.05;
			const verdict = decisive
				? `${d.meanDelta !== null && d.meanDelta > 0 ? d.armB : d.armA} better (p<0.05)`
				: "not distinguishable";
			lines.push(
				`| ${d.armA} → ${d.armB} | ${d.nTasks} | ${delta} | ${ci} | ${d.wins}-${d.losses}-${d.ties} | ${d.signTestP.toFixed(3)} | ${verdict} |`,
			);
		}
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
