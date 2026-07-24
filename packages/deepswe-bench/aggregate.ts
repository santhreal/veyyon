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

import { ARGOT_PREAMBLE, DEFAULT_SIGIL } from "argot";

/**
 * Heading line of argot's teaching preamble, taken from argot's OWN rendered
 * preamble ({@link ARGOT_PREAMBLE}) so this marker can never drift from the text
 * the runtime injects. `renderPreamble`'s `tools` option changes only the body,
 * not this `## Project shorthand (Argot)` heading, so a single substring match on
 * it is a sound "was the model taught to encode this session" probe regardless of
 * which preamble variant fired.
 */
export const ARGOT_PREAMBLE_HEADING: string = ARGOT_PREAMBLE.split("\n", 1)[0] ?? "";

/**
 * True when a session's system prompt contains argot's teaching preamble, i.e.
 * the ENCODE treatment actually fired for that session.
 *
 * This is the authoritative, post-run treatment-applied probe, and it is the one
 * check the pre-run allowlist guard ({@link ../treatment-guard!encodeArmModelMismatch})
 * structurally cannot make: the pre-run guard matches the REQUESTED `--model`
 * string against the allowlist, but the runtime resolves that id through the
 * catalog (provider aliases, effort-tier collapsing) to a different logical id
 * BEFORE the encode gate sees it. A requested `google-antigravity/gemini-3.6-flash`
 * that resolves to logical `gemini-3.5-flash` passes the pre-run guard (3.6 is on
 * the list) yet fails the gate (the resolved 3.5 is not), so the arm silently
 * degrades to decode-only. Reading the actual system prompt the model was given
 * reflects the model AFTER resolution and catches exactly that silent degrade.
 */
export function systemPromptTeachesArgot(systemPrompt: string): boolean {
	if (ARGOT_PREAMBLE_HEADING === "") return false;
	return systemPrompt.includes(ARGOT_PREAMBLE_HEADING);
}

/**
 * Whether an assistant content block carries an argot handle (a `§name` token).
 *
 * This is the primitive behind the "did the encode treatment fire" probe. The
 * subtlety it exists to fix: encode does NOT only surface in prose. The argot
 * preamble tells the model to write a handle "in prose, a command, or a diff", so
 * on a coding agent a handle most often lands inside a tool call's `arguments` (a
 * shell command string, an edit diff), NOT a text block. A probe that scanned only
 * text blocks would undercount encode and could read a heavy-encode arm as
 * `0 encoded`, which would falsely conclude the treatment never fired and silently
 * invalidate every token delta. So this checks the text block AND the serialized
 * tool-call arguments. The sigil is argot's own {@link DEFAULT_SIGIL} (one place —
 * the bench never customizes it, and a divergence would show up as zero encoded
 * rows rather than a wrong count).
 */
export function blockContainsSigil(block: unknown, sigil: string = DEFAULT_SIGIL): boolean {
	if (typeof block !== "object" || block === null) return false;
	const b = block as Record<string, unknown>;
	if (typeof b.text === "string" && b.text.includes(sigil)) return true;
	if (b.type === "toolCall" && b.arguments !== undefined) {
		try {
			return JSON.stringify(b.arguments).includes(sigil);
		} catch {
			// A non-serializable arguments object (cycles) cannot carry a plain
			// handle string we could have counted; treat it as sigil-free rather
			// than throwing out of a read-only probe.
			return false;
		}
	}
	return false;
}

export interface SessionUsage {
	inputTokens: number;
	outputTokens: number;
	cacheTokens: number;
	costUsd: number;
	argotLoadCalls: number;
	assistantMsgsWithSigil: number;
	toolCalls: Record<string, number>;
}

/**
 * Tally token usage and tool telemetry from a session's messages.
 *
 * The bug this consolidates and fixes: one tool invocation appears in the
 * transcript TWICE — as a `toolCall` block on the assistant message that
 * requested it, and again as a `toolResult` message carrying its output. The
 * old parser incremented the distribution on BOTH, so every tool count was
 * doubled (a run with 40 real `eval` calls reported 80). Tools are now tallied
 * exactly once, from the assistant's `toolCall` blocks — the model's actual
 * invocations — and `argot_load` is counted from that same place, so the
 * treatment probe and the tool distribution can never disagree about how many
 * times the model called it.
 *
 * `messages` is the ordered sequence of `entry.message` objects from a session
 * jsonl (already JSON-parsed by the caller; malformed lines dropped upstream).
 * Token fields read veyyon's own `usage` accounting on each assistant message.
 */
export function tallyUsage(messages: Array<Record<string, unknown>>): SessionUsage {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheTokens = 0;
	let costUsd = 0;
	let argotLoadCalls = 0;
	let assistantMsgsWithSigil = 0;
	const toolCalls: Record<string, number> = {};
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const usage = (message.usage ?? {}) as Record<string, number | Record<string, number>>;
		inputTokens += (usage.input as number) || 0;
		outputTokens += (usage.output as number) || 0;
		cacheTokens += ((usage.cacheRead as number) || 0) + ((usage.cacheWrite as number) || 0);
		costUsd += (usage.cost as Record<string, number>)?.total || 0;
		const content = (message.content ?? []) as Array<Record<string, unknown>>;
		// Encode is detected wherever a handle can land — a text block OR a tool
		// call's arguments (commands and diffs carry handles too). See
		// blockContainsSigil; scanning text only would undercount encode.
		if (content.some(b => blockContainsSigil(b))) assistantMsgsWithSigil++;
		for (const block of content) {
			if (
				typeof block === "object" &&
				block !== null &&
				block.type === "toolCall" &&
				typeof block.name === "string"
			) {
				toolCalls[block.name] = (toolCalls[block.name] ?? 0) + 1;
				if (block.name === "argot_load") argotLoadCalls++;
			}
		}
	}
	return { inputTokens, outputTokens, cacheTokens, costUsd, argotLoadCalls, assistantMsgsWithSigil, toolCalls };
}

/**
 * Extract a provider "finish reason" (e.g. `PROHIBITED_CONTENT`, `SAFETY`,
 * `RECITATION`) from captured agent output, if one is present.
 *
 * These are content-filter / policy stops: the provider aborts generation
 * mid-turn and the agent process exits non-zero, which the bench records as an
 * errored (excluded) sample. Naming the reason matters because a provider refusal
 * is NOT the same failure as a genuine agent crash, and — critically — a refusal
 * that hits one arm more than another is a confound (or, if it tracks the
 * treatment such as an injected preamble, a real effect). Either way it must be
 * distinguishable, not folded into a generic error bucket. Returns null when no
 * finish-reason marker is found. Matches both `finish reason:` and `finish_reason`.
 */
export function providerFinishReason(text: string): string | null {
	const m = text.match(/finish[ _]reason:?\s*([A-Z][A-Z_]{2,})/);
	return m ? (m[1] as string) : null;
}

/**
 * Group an errored sample under a short, comparable failure label.
 *
 * The stored error is either pier's stringified `exception_info`
 * (`{"exception_type":"…","exception_message":"…"}`) or a runner-side string
 * (a timeout, a pier exit line). This pulls out a stable label — the exception
 * type, refined with a provider finish reason when one is embedded — so the
 * report can show WHICH failure mode hit each arm and expose an asymmetry rather
 * than an anonymous count. Never throws on non-JSON input.
 */
export function classifyError(error: string): string {
	const finish = providerFinishReason(error);
	let base = "other";
	// Regex rather than JSON.parse: run.ts appends a recovered `finish_reason: …`
	// after the exception_info JSON, so the whole string is not valid JSON. Pulling
	// the type out directly stays robust to that (and to any trailing pier text).
	const typeMatch = error.match(/"exception_type"\s*:\s*"([^"]+)"/);
	if (typeMatch) {
		base = typeMatch[1] as string;
	} else if (/timed out/i.test(error)) {
		base = "timeout";
	}
	return finish ? `${base} (${finish})` : base;
}

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
	/**
	 * Whether this trial's session system prompt actually taught argot's encode
	 * preamble (see {@link systemPromptTeachesArgot}). `true` = encode fired,
	 * `false` = a session was present but was NOT taught to encode (the silent
	 * decode-only degrade an encode arm must never hide), `null` = no readable
	 * session, so presence is unknown. This is the authoritative treatment-applied
	 * signal, resolved from the prompt the model was actually given.
	 */
	argotPreamblePresent: boolean | null;
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

/** One arm-vs-arm paired comparison on an arbitrary per-cell metric. */
export interface PairedComparison {
	/** Reference arm (the "from" side). */
	armA: string;
	/** Candidate arm (the "to" side); {@link meanDelta} is B minus A on the metric. */
	armB: string;
	/** Tasks with a non-null metric in BOTH arms — the paired unit count. */
	nTasks: number;
	/** Mean over paired tasks of (metric_B - metric_A). Null when nTasks is 0. */
	meanDelta: number | null;
	/** 95% normal-approximation CI for {@link meanDelta} (z * sd/sqrt(nTasks)). Null when nTasks < 2. */
	ciLow: number | null;
	ciHigh: number | null;
	/** Tasks where B's metric exceeded A's. */
	pos: number;
	/** Tasks where A's metric exceeded B's. */
	neg: number;
	/** Tasks where the two metrics were equal. */
	ties: number;
	/** Two-sided exact sign-test p-value over pos vs neg (see {@link signTestPValue}). */
	signTestP: number;
}

/**
 * The paired-by-task core every arm comparison shares. For each unordered arm pair
 * (first-seen order), a task counts only when `metricOf` is non-null for BOTH arms'
 * cells; the per-task delta is `valueB - valueA`. Returns the mean delta with a
 * normal-approximation CI (effect size) and an exact sign test over the up/down
 * counts (the verdict). Pure and deterministic. One implementation so pass-rate and
 * efficiency comparisons cannot drift apart.
 */
function pairedByTask(
	results: readonly ArmResult[],
	metricOf: (cell: CellSummary) => number | null,
): PairedComparison[] {
	const arms = [...new Set(results.map(r => r.arm))];
	const tasks = [...new Set(results.map(r => r.task))];
	const valueAt = (arm: string, task: string): number | null =>
		metricOf(summarizeCell(results.filter(r => r.arm === arm && r.task === task)));
	const out: PairedComparison[] = [];
	for (let i = 0; i < arms.length; i++) {
		for (let j = i + 1; j < arms.length; j++) {
			const armA = arms[i] as string;
			const armB = arms[j] as string;
			const deltas: number[] = [];
			let pos = 0;
			let neg = 0;
			let ties = 0;
			for (const task of tasks) {
				const a = valueAt(armA, task);
				const b = valueAt(armB, task);
				if (a === null || b === null) continue; // unpaired: one arm has no value here
				const d = b - a;
				deltas.push(d);
				if (d > 0) pos++;
				else if (d < 0) neg++;
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
				pos,
				neg,
				ties,
				signTestP: signTestPValue(pos, neg),
			});
		}
	}
	return out;
}

/**
 * Every unordered arm pair, compared PAIRED by task on PASS RATE. A task counts only
 * when both arms produced at least one OK sample. This is what lets the report state
 * whether B actually beat A on correctness instead of asking the reader to eyeball
 * two overlapping independent intervals. Thin wrapper over {@link pairedByTask};
 * `wins`/`losses` are the pass-rate up/down counts.
 */
export function pairwiseArmDeltas(results: readonly ArmResult[]): ArmDelta[] {
	return pairedByTask(results, c => c.passRate).map(p => ({
		armA: p.armA,
		armB: p.armB,
		nTasks: p.nTasks,
		meanDelta: p.meanDelta,
		ciLow: p.ciLow,
		ciHigh: p.ciHigh,
		wins: p.pos,
		losses: p.neg,
		ties: p.ties,
		signTestP: p.signTestP,
	}));
}

/**
 * Every unordered arm pair, compared PAIRED by task on an efficiency metric (mean
 * output tokens, mean cost, ...). This is what makes an efficiency feature like argot
 * measurable: its promise is FEWER tokens at equal reward, so the win is a negative
 * paired delta here (B cheaper than A) that the sign test confirms, READ TOGETHER
 * WITH the pass-rate comparison as a guardrail — cheaper only counts if correctness
 * did not drop. `metric` picks the per-cell number to compare; a cell whose metric is
 * null (all-errored, or the metric was never recorded) drops the task from the pair.
 */
export function pairwiseMetricDeltas(
	results: readonly ArmResult[],
	metric: (cell: CellSummary) => number | null,
): PairedComparison[] {
	return pairedByTask(results, metric);
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

		// Efficiency comparison. For a feature whose promise is FEWER tokens at equal
		// reward (argot), this is the section that actually measures the claim: a win
		// is a negative paired delta (B cheaper) the sign test confirms, READ WITH the
		// pass-rate table above as a guardrail — cheaper only counts if correctness held.
		const passByPair = new Map(pairwiseArmDeltas(results).map(d => [`${d.armA}→${d.armB}`, d]));
		const metrics: Array<{
			label: string;
			unit: string;
			of: (c: CellSummary) => number | null;
			raw: (r: ArmResult) => number | null;
			digits: number;
		}> = [
			{ label: "output tok", unit: "tok", of: c => c.meanOutputTokens, raw: r => r.outputTokens, digits: 0 },
			{ label: "cost", unit: "$", of: c => c.meanCostUsd, raw: r => r.costUsd, digits: 4 },
		];
		lines.push("");
		lines.push("## Efficiency comparison (paired by task)");
		lines.push("");
		lines.push(
			"Δ is arm B minus arm A on the per-task mean, over tasks both arms ran. A negative Δ means B is cheaper. " +
				"The verdict pairs the sign test on this metric with the pass-rate guardrail: B is an efficiency win only " +
				"when it is significantly cheaper (p<0.05) AND the pass-rate comparison above did not find B worse.",
		);
		lines.push("");
		lines.push(
			"| metric | A → B | paired tasks | Δ mean | Δ 95% CI | cheaper-B / dearer-B / tie | sign-test p | verdict |",
		);
		lines.push("|---|---|---|---|---|---|---|---|");
		for (const m of metrics) {
			// A metric the provider never reports (e.g. cost is 0 for a provider with no
			// pricing entry) is uniformly 0/null across every OK sample. Its paired delta
			// is then 0 with p=1, which the loop below would render as "not
			// distinguishable" — reading as "measured and found equal" when it was never
			// measured at all. Detect the no-signal case and say so, so a missing metric
			// is never mistaken for a null result.
			const hasSignal = results.some(r => !r.error && (m.raw(r) ?? 0) !== 0);
			if (!hasSignal) {
				lines.push(`| ${m.label} | — | — | — | — | — | — | not measured (all 0/null for this provider) |`);
				continue;
			}
			for (const d of pairwiseMetricDeltas(results, m.of)) {
				const dv = (x: number) => (m.digits > 0 ? x.toFixed(m.digits) : String(Math.round(x)));
				const delta = d.meanDelta === null ? "—" : (d.meanDelta >= 0 ? "+" : "") + dv(d.meanDelta);
				const ci =
					d.ciLow === null || d.ciHigh === null
						? "—"
						: `[${(d.ciLow >= 0 ? "+" : "") + dv(d.ciLow)}, ${(d.ciHigh >= 0 ? "+" : "") + dv(d.ciHigh)}]`;
				const cheaperB = d.neg; // B < A on this cost metric
				const dearerB = d.pos;
				const cheaperSig = cheaperB + dearerB > 0 && d.signTestP < 0.05 && d.meanDelta !== null && d.meanDelta < 0;
				const pass = passByPair.get(`${d.armA}→${d.armB}`);
				// The guardrail: B is not worse on correctness (its pass-rate comparison is
				// not a significant loss for B).
				const passHeld = !pass || !(pass.signTestP < 0.05 && pass.meanDelta !== null && pass.meanDelta < 0);
				const verdict = cheaperSig
					? passHeld
						? `${d.armB} cheaper, reward held`
						: `${d.armB} cheaper BUT reward dropped`
					: dearerB + cheaperB > 0 && d.signTestP < 0.05 && d.meanDelta !== null && d.meanDelta > 0
						? `${d.armB} dearer`
						: "not distinguishable";
				lines.push(
					`| ${m.label} | ${d.armA} → ${d.armB} | ${d.nTasks} | ${delta} ${m.unit} | ${ci} | ${cheaperB}/${dearerB}/${d.ties} | ${d.signTestP.toFixed(3)} | ${verdict} |`,
				);
			}
		}
	}
	// Errors (per arm): a crashed or provider-refused sample is EXCLUDED from every
	// rate and mean above, so an arm that errors more is silently measured on fewer
	// (and possibly easier) samples. If a content-filter refusal or a crash hits one
	// arm more than another — most of all if it tracks the treatment, e.g. an
	// injected preamble — a token or pass-rate delta against that arm may be a
	// selection effect, not a real difference. This groups every excluded sample by
	// failure reason across ALL arms (including arms with zero errors, so the
	// asymmetry is visible), turning an anonymous "+N err" count into evidence.
	const errored = results.filter(r => r.error);
	if (errored.length > 0) {
		const reasons = [...new Set(errored.map(r => classifyError(r.error as string)))].sort();
		lines.push("");
		lines.push("## Errors (per arm)");
		lines.push("");
		lines.push(
			"Each sample counted here is EXCLUDED from every rate and mean above. Watch for an asymmetry: " +
				"an arm that refuses or crashes more is measured on fewer samples, so a delta against it can be a " +
				"selection effect rather than a real effect of the arm.",
		);
		lines.push("");
		lines.push(`| arm | total err | ${reasons.join(" | ")} |`);
		lines.push(`|---|---|${reasons.map(() => "---|").join("")}`);
		for (const arm of arms) {
			const armErrs = errored.filter(r => r.arm === arm);
			const cells = reasons.map(reason => armErrs.filter(r => classifyError(r.error as string) === reason).length);
			lines.push(`| ${arm} | ${armErrs.length} | ${cells.join(" | ")} |`);
		}
	}
	// Per-arm treatment-application probe: an argot encode arm is only measuring its
	// treatment if the model actually LOADED a dictionary and WROTE handles. A row of
	// zeros here means the encode never fired, so any token delta above is comparing
	// "encode on paper" against decode — the eval is inert, not a null result.
	const okByArm = (a: string) => results.filter(r => r.arm === a && !r.error);
	const argotArms = arms.filter(a =>
		okByArm(a).some(
			r => r.argotLoadCalls !== null || r.assistantMsgsWithSigil !== null || r.argotPreamblePresent !== null,
		),
	);
	if (argotArms.length > 0) {
		lines.push("");
		lines.push("## Argot treatment applied? (per arm)");
		lines.push("");
		lines.push(
			"`preamble taught` is the authoritative signal: it reads the actual system prompt the model was " +
				"given, so it reflects the model AFTER catalog id resolution. An encode arm whose `preamble taught` " +
				"is `0/N` never fired the treatment (a silent degrade to decode-only) and every token delta against " +
				"it is inert, whatever the § counts say.",
		);
		lines.push("");
		lines.push(
			"| arm | OK runs | preamble taught | mean argot_load calls | mean msgs with § | runs that encoded (§>0) |",
		);
		lines.push("|---|---|---|---|---|---|");
		for (const a of argotArms) {
			const rows = okByArm(a);
			const encoded = rows.filter(r => (r.assistantMsgsWithSigil ?? 0) > 0).length;
			const taught = rows.filter(r => r.argotPreamblePresent === true).length;
			const known = rows.filter(r => r.argotPreamblePresent !== null).length;
			const taughtCell = known === 0 ? "unknown" : `${taught}/${known}`;
			lines.push(
				`| ${a} | ${rows.length} | ${taughtCell} | ${fmt(mean(rows.map(r => r.argotLoadCalls)), 2)} | ` +
					`${fmt(mean(rows.map(r => r.assistantMsgsWithSigil)), 2)} | ${encoded}/${rows.length} |`,
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
