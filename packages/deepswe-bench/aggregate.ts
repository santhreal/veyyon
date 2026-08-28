/** Pure result aggregation and report rendering for the DeepSWE bench. */

import { ARGOT_PREAMBLE, DEFAULT_SIGIL } from "argot";
import {
	type CostBreakdown,
	costShares,
	priceTokens,
	type RateCard,
	REFERENCE_RATE_CARD,
	type TokenMix,
} from "./cost-model";

/** Heading line of argot's teaching preamble, taken from argot's OWN rendered */
export const ARGOT_PREAMBLE_HEADING: string = ARGOT_PREAMBLE.split("\n", 1)[0] ?? "";

/** True when a session's system prompt contains argot's teaching preamble, i.e. */
export function systemPromptTeachesArgot(systemPrompt: string): boolean {
	if (ARGOT_PREAMBLE_HEADING === "") return false;
	return systemPrompt.includes(ARGOT_PREAMBLE_HEADING);
}

/** Whether an assistant content block carries an argot handle (a `§name` token). */
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
	/** Cache reads and cache writes summed. */
	cacheTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	argotLoadCalls: number;
	assistantMsgsWithSigil: number;
	toolCalls: Record<string, number>;
}

/** Tally token usage and tool telemetry from a session's messages. */
export function tallyUsage(messages: Array<Record<string, unknown>>): SessionUsage {
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let costUsd = 0;
	let argotLoadCalls = 0;
	let assistantMsgsWithSigil = 0;
	const toolCalls: Record<string, number> = {};
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		const usage = (message.usage ?? {}) as Record<string, number | Record<string, number>>;
		inputTokens += (usage.input as number) || 0;
		outputTokens += (usage.output as number) || 0;
		cacheReadTokens += (usage.cacheRead as number) || 0;
		cacheWriteTokens += (usage.cacheWrite as number) || 0;
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
	return {
		inputTokens,
		outputTokens,
		cacheTokens: cacheReadTokens + cacheWriteTokens,
		cacheReadTokens,
		cacheWriteTokens,
		costUsd,
		argotLoadCalls,
		assistantMsgsWithSigil,
		toolCalls,
	};
}

/** Extract a provider "finish reason" (e.g. `PROHIBITED_CONTENT`, `SAFETY`, */
export function providerFinishReason(text: string): string | null {
	const m = text.match(/finish[ _]reason:?\s*([A-Z][A-Z_]{2,})/);
	return m ? (m[1] as string) : null;
}

/** What a provider quota stop tells us, once one is found. Both fields are best-effort. */
export interface ProviderQuotaStop {
	/** ISO timestamp the provider says the quota resets at, or null if it did not say. */
	resetAt: string | null;
	/** The model whose quota ran out, as the provider named it, or null. */
	model: string | null;
}

/** Whether captured output shows the PROVIDER refusing on quota, and what it said */
export function providerQuotaStop(text: string | null | undefined): ProviderQuotaStop | null {
	if (!text) return null;
	if (!/RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED/.test(text)) return null;
	const resetAt = text.match(/"quotaResetTimeStamp":\s*"([^"]+)"/)?.[1] ?? text.match(/resets_at=(\S+)/)?.[1] ?? null;
	const model = text.match(/"model":\s*"([^"]+)"/)?.[1] ?? text.match(/quota_model=(\S+)/)?.[1] ?? null;
	return { resetAt, model };
}

/** The compact, re-parseable form of a quota stop, folded into a trial's error */
export function quotaStopMarker(stop: ProviderQuotaStop): string {
	const parts = ["QUOTA_EXHAUSTED"];
	if (stop.resetAt) parts.push(`resets_at=${stop.resetAt}`);
	if (stop.model) parts.push(`quota_model=${stop.model}`);
	return parts.join(" ");
}

/** Group an errored sample under a short, comparable failure label. */
/** Error string stamped on a trial the agent RAN to completion (no exception) but the */
export const NO_REWARD_ERROR = "verifier produced no reward: missing verifier_result.rewards.reward";

/** Whether a parsed verifier reward means "the verifier did not score this trial". */
export function noRewardError(reward: number | null): boolean {
	return !Number.isFinite(reward ?? Number.NaN);
}

/** Whether an error string means "the agent ran out its whole time budget", as */
export function isAgentTimeout(error: string | null): boolean {
	if (error === null) return false;
	return /trial timed out after \d+s/i.test(error) || error.includes("AgentTimeoutError");
}

/** The docker daemon's answer when the harness asks a container for a patch the */
const NO_PATCH_IN_CONTAINER = "Could not find the file /logs/artifacts/model.patch in container";

/** Markers that mean the trial was STOPPED rather than finished: pier's SIGTERM */
const CANCELLATION_MARKERS = ["KeyboardInterrupt", "CancelledError", "AgentTimeoutError"] as const;

/** Whether a trial's traceback means "the agent ran to completion and produced no */
export function finishedWithoutPatch(traceback: string | null | undefined): boolean {
	if (!traceback) return false;
	if (!traceback.includes(NO_PATCH_IN_CONTAINER)) return false;
	return !CANCELLATION_MARKERS.some(marker => traceback.includes(marker));
}

/** A "hard error" is a trial the agent never produced any output for: an error is */
export function isHardError(result: { error: string | null; outputTokens: number | null }): boolean {
	// A timeout is explicitly NOT a hard error, however little the trial recorded.
	// The canary aborts a whole run on the strength of this predicate, and a batch
	// of genuinely long tasks against a tight `--trial-timeout` would otherwise
	// look identical to an unservable model and kill the run.
	if (isAgentTimeout(result.error)) return false;
	return result.error !== null && result.outputTokens === null;
}

/** The single most common failure reason across a set of hard-error strings, for */
/** The fail-fast canary's abort decision, as a pure predicate so it can be tested */
export function shouldTripCanary(
	results: ReadonlyArray<{ error: string | null; outputTokens: number | null }>,
	canarySize: number,
): boolean {
	return results.length >= canarySize && results.length > 0 && results.every(isHardError);
}

/** The per-ARM half of the fail-fast canary, as a pure predicate. Returns the */
export function armCanaryFailure(
	results: ReadonlyArray<{ arm: string; error: string | null; outputTokens: number | null }>,
	canarySize: number,
): string | undefined {
	if (canarySize <= 0) return undefined;
	const completed = new Map<string, { total: number; hard: number }>();
	for (const result of results) {
		const entry = completed.get(result.arm) ?? { total: 0, hard: 0 };
		entry.total += 1;
		if (isHardError(result)) entry.hard += 1;
		completed.set(result.arm, entry);
	}
	for (const [arm, { total, hard }] of completed) {
		if (total >= canarySize && total === hard) return arm;
	}
	return undefined;
}

export function mostCommonAgentReason(reasons: readonly string[]): string {
	const counts = new Map<string, number>();
	for (const raw of reasons) {
		const reason = raw.trim();
		if (reason === "") continue;
		counts.set(reason, (counts.get(reason) ?? 0) + 1);
	}
	let best: string | null = null;
	let bestCount = 0;
	for (const [reason, count] of counts) {
		if (count > bestCount) {
			best = reason;
			bestCount = count;
		}
	}
	return best ?? "(no agent-side reason captured; check a failed job's agent/veyyon.txt)";
}

export function classifyError(error: string): string {
	// A verifier-no-reward is a runner-side string with no exception_type; give it its
	// own stable label so a scorer outage shows as a distinct, comparable failure mode
	// (and its per-arm asymmetry is visible) rather than dissolving into "other".
	if (error.includes(NO_REWARD_ERROR)) return "verifier-no-reward";
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

/** The job name is the single identifier for a container run, a config file, and a */
export function jobNameOf(arm: string, task: string, repeat: number, repeats: number): string {
	return repeats > 1 ? `${arm}__${task}__r${repeat}` : `${arm}__${task}`;
}

/** Pick `limit` tasks spread EVENLY across the sorted task set, for a smoke/debug */
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

/** Provenance of a task list: is it safe to report as a headline number, or is it a */
export interface TaskSetProvenance {
	/** Whether a `@headline` or `@biased` directive was found in the header. */
	marked: boolean;
	/** True for a selection-biased set (`@biased`) that must not be a headline. */
	biased: boolean;
	/** The directive's explanatory note, if any. */
	note: string | null;
}

/** Parse a task list's header comments for its {@link TaskSetProvenance} directive. */
export function parseTaskListProvenance(content: string): TaskSetProvenance {
	for (const raw of content.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		if (!line.startsWith("#")) break; // header ended: first task reached
		const body = line.replace(/^#+\s*/, "");
		const biased = body.match(/^@biased\b:?\s*(.*)$/i);
		if (biased) return { marked: true, biased: true, note: (biased[1] as string).trim() || null };
		const headline = body.match(/^@headline\b:?\s*(.*)$/i);
		if (headline) return { marked: true, biased: false, note: (headline[1] as string).trim() || null };
	}
	return { marked: false, biased: false, note: null };
}

/** The banner a report prints when the run it describes was cut short by the */
export function renderQuotaTruncationBanner(results: readonly ArmResult[]): string | null {
	const stopped = results.filter(r => providerQuotaStop(r.error) !== null);
	if (stopped.length === 0) return null;
	const armsHit = [...new Set(stopped.map(r => r.arm))].sort();
	const resetAt = stopped.map(r => providerQuotaStop(r.error)?.resetAt).find(Boolean);
	const when = resetAt ? ` Quota reset was ${resetAt}.` : "";
	return (
		`> ⚠️ **This run was CUT SHORT by provider quota — it is incomplete, not a result.** ` +
		`${stopped.length} trial(s) produced nothing because the provider refused on quota, ` +
		`affecting arm(s): ${armsHit.join(", ")}.${when} ` +
		`An arm that lost samples is UNDER-MEASURED, and its absence must not be read as data. ` +
		`Rerun after the reset before comparing anything below.`
	);
}

/** The one-line banner the report prints for a task set's provenance, so a reader can */
export function renderTaskSetProvenanceBanner(prov: TaskSetProvenance): string {
	if (prov.biased) {
		const why = prov.note ? ` ${prov.note}` : "";
		return `> ⚠️ **Task set is SELECTION-BIASED — a best-case upper bound, NOT a headline number.**${why}`;
	}
	if (prov.marked) {
		const why = prov.note ? ` ${prov.note}` : "";
		return `> Task set: headline (unbiased).${why}`;
	}
	return "> ⚠️ Task-set provenance is unmarked. Add `# @headline` or `# @biased: <reason>` to the task list header so a best-case subset is never read as a headline.";
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
	/** Cache reads and cache writes, separately, because they are priced 4x apart */
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	/** Reasons for every mid-session system-prompt change, in order, one per full */
	promptCacheInvalidations: string[] | null;
	costUsd: number | null;
	agentSeconds: number | null;
	argotLoadCalls: number | null;
	assistantMsgsWithSigil: number | null;
	/** Whether this trial's session system prompt actually taught argot's encode */
	argotPreamblePresent: boolean | null;
	/** The handle count the launch project's argot dictionary actually loaded for */
	argotHandlesLoaded: number | null;
	/** Whether the handle table actually reached the model, read from the SDK's */
	argotHandlesTaught: boolean | null;
	/** The effect-size ceiling for this trial: how much shorthand could have saved at */
	encodeHeadroom: EncodeHeadroom | null;
	toolCalls: Record<string, number> | null;
	error: string | null;
}

/** A trial result with every measurement still unknown, which is the honest */
export function emptyArmResult(arm: string, task: string, repeat: number): ArmResult {
	return {
		arm,
		task,
		repeat,
		reward: null,
		partial: null,
		f2p: null,
		p2p: null,
		inputTokens: null,
		outputTokens: null,
		cacheTokens: null,
		cacheReadTokens: null,
		cacheWriteTokens: null,
		promptCacheInvalidations: null,
		costUsd: null,
		agentSeconds: null,
		argotLoadCalls: null,
		assistantMsgsWithSigil: null,
		argotPreamblePresent: null,
		argotHandlesLoaded: null,
		argotHandlesTaught: null,
		encodeHeadroom: null,
		toolCalls: null,
		error: null,
	};
}

/** The summary of one group of samples (a whole arm, or a single (arm, task) cell). */
export interface CellSummary {
	/** All attempts in the group, including errored ones. */
	total: number;
	/** Attempts EXCLUDED because the agent never got a fair run: an unservable */
	errors: number;
	/** Attempts where the agent ran its whole time budget and produced no passing */
	timedOut: number;
	/** The pass-rate denominator: scored attempts plus timed-out ones. NOT the */
	n: number;
	/** OK attempts with reward exactly 1. */
	passes: number;
	/** passes / n, or null when n is 0. */
	passRate: number | null;
	/** Binomial normal-approximation standard error of {@link passRate}: */
	stdErr: number | null;
	/** Lower / upper bound of the Wilson score 95% confidence interval for */
	wilsonLow: number | null;
	wilsonHigh: number | null;
	meanReward: number | null;
	meanPartial: number | null;
	meanOutputTokens: number | null;
	/** Mean uncached input tokens. Present so the efficiency comparison can TEST a */
	meanInputTokens: number | null;
	meanCostUsd: number | null;
	sumOutputTokens: number;
	sumCostUsd: number;
	sumInputTokens: number;
	sumCacheTokens: number;
	sumAgentSeconds: number;
	/** Whether the provider reported a real per-request price for this group: true */
	costPriced: boolean;
	/** The cell's token mix priced at {@link REFERENCE_RATE_CARD}, broken out by */
	refCost: CostBreakdown;
	/** Whether every OK run in the cell reported the cache read/write split. */
	refCostMeasurable: boolean;
}

function mean(values: Array<number | null>): number | null {
	const nums = values.filter((v): v is number => v !== null && v !== undefined);
	if (nums.length === 0) return null;
	return nums.reduce((a, v) => a + v, 0) / nums.length;
}

/** The sampling temperature the bench pins for every arm that does not set its own. */
export const PINNED_TEMPERATURE = 0;

/** The temperature one arm actually runs at: the arm's own `temperature` when it */
export function effectiveTemperature(config: unknown, pinned: number = PINNED_TEMPERATURE): number {
	if (config !== null && typeof config === "object" && "temperature" in config) {
		const t = (config as { temperature: unknown }).temperature;
		if (typeof t === "number" && Number.isFinite(t) && t >= 0) return t;
	}
	return pinned;
}

/** z for a two-sided 95% interval (standard normal 0.975 quantile). */
const Z_95 = 1.959963984540054;

/** Wilson score confidence interval for a binomial proportion (passes out of n). */
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

/** Two-sided exact sign-test p-value for a paired comparison: given `wins` tasks */
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

/** Whether a paired comparison could reach significance AT ALL at its current task */
export function sweepCanReachSignificance(nDecisive: number, familySize: number, alpha = 0.05): boolean {
	if (nDecisive <= 0) return false;
	const bestCaseRaw = signTestPValue(nDecisive, 0);
	const bestCaseAdjusted = Math.min(1, bestCaseRaw * Math.max(1, familySize));
	return bestCaseAdjusted < alpha;
}

/** Holm–Bonferroni step-down adjustment of a family of p-values, returned aligned to */
export function holmBonferroni(pValues: readonly number[]): number[] {
	const m = pValues.length;
	if (m === 0) return [];
	const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
	const adjusted = new Array<number>(m);
	let running = 0;
	order.forEach((entry, rank) => {
		// rank is 0-based; the step-down factor is (m - rank), i.e. m for the smallest.
		const val = Math.min(1, entry.p * (m - rank));
		running = Math.max(running, val);
		adjusted[entry.i] = running;
	});
	return adjusted;
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
	/** 95% CI for {@link meanDelta} from the per-task deltas (normal approximation, */
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

/** The paired-by-task core every arm comparison shares. For each unordered arm pair */
function pairedByTask(
	results: readonly ArmResult[],
	metricOf: (cell: CellSummary) => number | null,
): PairedComparison[] {
	// Sorted, not insertion-ordered. A live run pushes rows as jobs finish (which
	// depends on --jobs and on which container happens to be slow) and a
	// reaggregate rebuilds them in readdir order, so the same data can arrive in
	// different orders. Deriving arm order from that would flip a pair's direction
	// between two renders of ONE run, inverting every delta's sign and making two
	// reports of the same data diff as though the result had changed.
	const arms = [...new Set(results.map(r => r.arm))].sort();
	const tasks = [...new Set(results.map(r => r.task))].sort();
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

/** Every unordered arm pair, compared PAIRED by task on PASS RATE. A task counts only */
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

/** Every unordered arm pair, compared PAIRED by task on an efficiency metric (mean */
export function pairwiseMetricDeltas(
	results: readonly ArmResult[],
	metric: (cell: CellSummary) => number | null,
): PairedComparison[] {
	return pairedByTask(results, metric);
}

/** Reduce a group of samples to a {@link CellSummary}. Pure: same input, same */
export function summarizeCell(rows: readonly ArmResult[]): CellSummary {
	// Three classes, not two. A scored trial has a reward and token counts. A
	// TIMED-OUT trial has neither, but the agent ran the full budget and produced
	// no passing patch, so it is a fail with no measurements: it belongs in the
	// pass-rate denominator and nowhere near a token or cost mean. Everything else
	// with an error is a trial the agent never got a fair run at, and stays
	// excluded. See {@link isAgentTimeout} for why conflating the last two
	// inflated every pass rate and hid arm-asymmetric slowdowns.
	const ok = rows.filter(r => !r.error);
	const timedOut = rows.filter(r => isAgentTimeout(r.error)).length;
	const n = ok.length + timedOut;
	const passes = ok.filter(r => r.reward === 1).length;
	const passRate = n > 0 ? passes / n : null;
	const stdErr = passRate === null ? null : Math.sqrt((passRate * (1 - passRate)) / n);
	const wilson = wilsonInterval(passes, n);
	const sum = (f: (r: ArmResult) => number | null) => ok.reduce((a, r) => a + (f(r) ?? 0), 0);
	return {
		total: rows.length,
		errors: rows.length - ok.length - timedOut,
		timedOut,
		n,
		passes,
		passRate,
		stdErr,
		wilsonLow: wilson.low,
		wilsonHigh: wilson.high,
		// Timeouts enter as reward 0, the continuous form of the same fail the pass
		// rate now counts. `partial` stays over scored rows only: a trial that never
		// finished has no partial credit to report, and inventing a 0 there would
		// claim the verifier looked and found nothing.
		meanReward: mean([...ok.map(r => r.reward), ...Array.from({ length: timedOut }, () => 0)]),
		meanPartial: mean(ok.map(r => r.partial)),
		meanOutputTokens: mean(ok.map(r => r.outputTokens)),
		meanInputTokens: mean(ok.map(r => r.inputTokens)),
		meanCostUsd: mean(ok.map(r => r.costUsd)),
		sumOutputTokens: sum(r => r.outputTokens),
		sumCostUsd: sum(r => r.costUsd),
		sumInputTokens: sum(r => r.inputTokens),
		sumCacheTokens: sum(r => r.cacheTokens),
		sumAgentSeconds: sum(r => r.agentSeconds),
		costPriced: ok.some(r => (r.costUsd ?? 0) > 0),
		refCost: priceTokens({
			inputTokens: sum(r => r.inputTokens),
			cacheReadTokens: sum(r => r.cacheReadTokens),
			cacheWriteTokens: sum(r => r.cacheWriteTokens),
			outputTokens: sum(r => r.outputTokens),
		}),
		// `!= null` deliberately, so it catches `undefined` too. Rows loaded from a
		// results.json written before the split carry no such property at all, and
		// a `!== null` check passes them as measurable; `sum()` then reads them as
		// 0 and the cache-read line prints as zero dollars on a run that did
		// millions of cache reads. That is a fabricated number in the one column
		// this section exists to report.
		refCostMeasurable: ok.length > 0 && ok.every(r => r.cacheReadTokens != null && r.cacheWriteTokens != null),
	};
}

/** Render which subsystems invalidated the provider's prefix cache, and how often. */
export function renderPromptCacheInvalidationSection(results: readonly ArmResult[], arms: readonly string[]): string {
	const lines: string[] = ["## Prompt cache invalidations", ""];
	const measured = results.filter(
		r => r.promptCacheInvalidations !== null && r.promptCacheInvalidations !== undefined,
	);
	if (measured.length === 0) {
		lines.push("> Not recorded for this run: it predates the instrumentation. Re-run to attribute cache misses.");
		return lines.join("\n");
	}
	lines.push("Each one costs the next request a full re-read of the conversation as fresh input.");
	lines.push("");
	lines.push("| arm | invalidations | per run | by cause |");
	lines.push("|---|---|---|---|");
	for (const arm of arms) {
		const rows = measured.filter(r => r.arm === arm && !r.error);
		if (rows.length === 0) continue;
		const all = rows.flatMap(r => r.promptCacheInvalidations ?? []);
		const byCause = new Map<string, number>();
		for (const reason of all) byCause.set(reason, (byCause.get(reason) ?? 0) + 1);
		const causes =
			byCause.size === 0
				? "none"
				: [...byCause.entries()]
						.sort((a, b) => b[1] - a[1])
						.map(([reason, n]) => `${reason} x${n}`)
						.join(", ");
		lines.push(`| ${arm} | ${all.length} | ${(all.length / rows.length).toFixed(1)} | ${causes} |`);
	}
	return lines.join("\n");
}

/** Render the reference-cost section: what each arm's tokens would cost at */
export function renderReferenceCostSection(results: readonly ArmResult[], arms: readonly string[]): string {
	const lines: string[] = [];
	lines.push("## Cost at reference rates");
	lines.push("");
	const cells = arms.map(arm => ({ arm, s: summarizeCell(results.filter(r => r.arm === arm)) }));
	const unmeasurable = cells.filter(c => c.s.n > 0 && !c.s.refCostMeasurable).map(c => c.arm);
	if (unmeasurable.length > 0) {
		lines.push(
			`> Not computed for ${unmeasurable.join(", ")}: these runs predate the cache read/write split, so ` +
				"their cache tokens cannot be priced (a read costs 0.075/M, a write 0.3833/M, and the older " +
				"records carry only the sum). Re-run to get a priced comparison.",
		);
		lines.push("");
	}
	lines.push(`Counterfactual, not billed. Rates: ${REFERENCE_RATE_CARD.source}.`);
	lines.push("");
	// THE PERCENTAGES BELOW ARE SUMS OVER WHATEVER EACH ARM COMPLETED, so they are
	// only a cost comparison when the arms completed the same amount of work. When a
	// run is cut short by quota the arms end up with very different sample counts and
	// the delta becomes a sample-count artifact wearing a result's clothes. Run
	// 2026-07-25T19-51-41 reported `discovery-all` at "-97.8%" purely because it
	// finished 1 task against baseline's 18, and nothing in the table said so.
	const counted = cells.filter(c => c.s.refCostMeasurable && c.s.n > 0);
	const sampleCounts = [...new Set(counted.map(c => c.s.n))];
	if (counted.length > 1 && sampleCounts.length > 1) {
		lines.push(
			`> **These percentages are NOT a cost comparison: the arms completed different numbers of trials** (` +
				counted.map(c => `${c.arm} ${c.s.n}`).join(", ") +
				`). Each figure is a SUM over whatever that arm finished, so an arm that ran fewer trials looks ` +
				`cheaper by exactly the work it never did. Re-run so both arms cover the same tasks, or compare ` +
				`only the tasks both completed. Read the per-task columns above instead.`,
		);
		lines.push("");
	}
	lines.push("| arm | samples | input | cache read | cache write | output | total | output share |");
	lines.push("|---|---|---|---|---|---|---|---|");
	const baseline = cells.find(c => c.s.refCostMeasurable);
	for (const { arm, s } of cells) {
		if (!s.refCostMeasurable) continue;
		const c = s.refCost;
		const shares = costShares(c);
		const money = (v: number) => `$${v.toFixed(4)}`;
		const withDelta = (v: number, base: number) => {
			if (!baseline || baseline.arm === arm || base <= 0) return money(v);
			const pct = ((v - base) / base) * 100;
			return `${money(v)} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`;
		};
		const b = baseline?.s.refCost;
		lines.push(
			`| ${arm} | ${s.n} | ${withDelta(c.input, b?.input ?? 0)} | ${withDelta(c.cacheRead, b?.cacheRead ?? 0)} | ` +
				`${withDelta(c.cacheWrite, b?.cacheWrite ?? 0)} | ${withDelta(c.output, b?.output ?? 0)} | ` +
				`**${withDelta(c.total, b?.total ?? 0)}** | ${(shares.output * 100).toFixed(1)}% |`,
		);
	}
	return lines.join("\n");
}

/** True when a cell's cost is UNPRICED: the provider reported no per-request cost */
export function costIsUnpriced(s: CellSummary): boolean {
	return !s.costPriced && s.sumOutputTokens > 0;
}

/** Share of a cell's attempts the HARNESS killed rather than the agent losing. */
export function timeoutRate(s: CellSummary): number | null {
	return s.n === 0 ? null : s.timedOut / s.n;
}

/** Why a pair's delta is or is not attributable to the arms. */
export interface TimeoutAttribution {
	/** Timed-out attempts on each side. */
	readonly timedOutA: number;
	readonly timedOutB: number;
	/** {@link timeoutRate} on each side; null when that side ran nothing. */
	readonly rateA: number | null;
	readonly rateB: number | null;
	/** |rateB - rateA|, or null when either side has no rate. */
	readonly rateGap: number | null;
	/** True when the delta cannot be charged to the arms. */
	readonly unattributable: boolean;
}

/** Whether a REWARD-shaped delta between two arms survives their timeout gap. */
export function rewardDeltaAttribution(
	a: CellSummary,
	b: CellSummary,
	observedDelta: number | null,
): TimeoutAttribution {
	const rateA = timeoutRate(a);
	const rateB = timeoutRate(b);
	const rateGap = rateA === null || rateB === null ? null : Math.abs(rateB - rateA);
	const base = { timedOutA: a.timedOut, timedOutB: b.timedOut, rateA, rateB, rateGap };
	if (rateGap === null || rateGap === 0) return { ...base, unattributable: false };
	// With no measured delta there is nothing for the gap to explain away, so the
	// gap alone is not a reason to withhold a verdict that was never reached.
	if (observedDelta === null) return { ...base, unattributable: false };
	return { ...base, unattributable: rateGap >= Math.abs(observedDelta) };
}

/** Whether a TOKEN- or COST-shaped delta between two arms survives their timeout */
export function efficiencyDeltaAttribution(a: CellSummary, b: CellSummary): TimeoutAttribution {
	const rateA = timeoutRate(a);
	const rateB = timeoutRate(b);
	return {
		timedOutA: a.timedOut,
		timedOutB: b.timedOut,
		rateA,
		rateB,
		rateGap: rateA === null || rateB === null ? null : Math.abs(rateB - rateA),
		unattributable: a.timedOut !== b.timedOut,
	};
}

/** The verdict text that replaces a winner when a delta is not attributable. */
export const TIMEOUT_UNATTRIBUTABLE_VERDICT = "not attributable (timeout gap)";

/** The report-wide banner for a run that lost trials to the harness. */
export function timeoutAttributionBanner(results: readonly ArmResult[], arms: readonly string[]): string | undefined {
	const cells = arms.map(arm => ({ arm, s: summarizeCell(results.filter(r => r.arm === arm)) }));
	const timedOut = cells.filter(c => c.s.timedOut > 0);
	if (timedOut.length === 0) return undefined;
	const counts = timedOut.map(c => `${c.arm}: ${c.s.timedOut}/${c.s.n}`).join(", ");
	const uneven = new Set(cells.map(c => c.s.timedOut)).size > 1;
	return (
		`> **The harness killed trials in this run** (${counts}). A timed-out trial is not an agent failure: ` +
		"it is a trial the bench cut off, and it records no token or cost measurement at all. Timeouts are " +
		"counted as fails in the pass rate and mean reward, and excluded from every token and cost mean.\n" +
		">\n" +
		(uneven
			? "> The arms did NOT time out equally, so some deltas below are marked " +
				`\`${TIMEOUT_UNATTRIBUTABLE_VERDICT}\`. An arm that is slower per turn hits the ceiling more ` +
				"often, which injects exactly the zeros that make it look worse on reward and drops exactly the " +
				"slowest runs from its token means. Rerun without `--trial-timeout` (the per-task budget from " +
				"`task.toml` is the default) before comparing those pairs.\n"
			: "> Every arm timed out the same number of times, so the deltas below are still paired against a " +
				"comparable censoring. The absolute pass rates are still depressed by the truncation.\n")
	);
}

/** Render a cell's cost honestly. When the cell is {@link costIsUnpriced}, return */
export function fmtCost(s: CellSummary, kind: "sum" | "mean"): string {
	if (costIsUnpriced(s)) return kind === "sum" ? "unpriced" : "—";
	const value = kind === "sum" ? s.sumCostUsd : s.meanCostUsd;
	if (value === null) return "—";
	return `$${value.toFixed(3)}`;
}

function fmt(n: number | null, digits = 0): string {
	if (n === null || n === undefined) return "—";
	return digits > 0 ? n.toFixed(digits) : String(Math.round(n));
}

/** A pass rate rendered with its 95% Wilson confidence interval, e.g. */
function fmtRate(s: CellSummary): string {
	if (s.passRate === null) return "—";
	const ci =
		s.wilsonLow === null || s.wilsonHigh === null ? "" : ` [${s.wilsonLow.toFixed(2)}–${s.wilsonHigh.toFixed(2)}]`;
	return `${s.passRate.toFixed(2)}${ci} (${s.passes}/${s.n})`;
}

/** Concatenate everything the model actually emitted across a session's messages. */
export function collectEmittedText(messages: Array<Record<string, unknown>>): string {
	const parts: string[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of (message.content ?? []) as Array<Record<string, unknown>>) {
			if (typeof block !== "object" || block === null) continue;
			if (typeof block.text === "string") parts.push(block.text);
			if (block.type === "toolCall" && block.arguments !== undefined) {
				try {
					parts.push(JSON.stringify(block.arguments));
				} catch {
					// A non-serializable arguments object cannot carry a plain expansion
					// we could have counted; skip it rather than throwing out of a probe.
				}
			}
		}
	}
	return parts.join("\n");
}

/** The ceiling on what shorthand could have saved a run, at perfect adoption. */
export interface EncodeHeadroom {
	/** Characters the model actually emitted (assistant text plus tool-call arguments). */
	emittedChars: number;
	/** Handles in the loaded vocabulary. */
	handles: number;
	/** Handles whose expansion appears at least once in what the model emitted. */
	usableHandles: number;
	/** Characters saved if EVERY occurrence of every expansion had been written as its handle. */
	maxSavedChars: number;
	/** {@link maxSavedChars} as a percentage of {@link emittedChars}; 0 when nothing was emitted. */
	maxSavedPct: number;
}

/** Compute the maximum saving shorthand could possibly have delivered on a run. */
export function encodeHeadroom(
	emitted: string,
	handles: Readonly<Record<string, string>>,
	sigil: string = DEFAULT_SIGIL,
): EncodeHeadroom {
	let usableHandles = 0;
	let maxSavedChars = 0;
	for (const [name, expansion] of Object.entries(handles)) {
		if (expansion.length === 0) continue;
		let occurrences = 0;
		let from = 0;
		for (;;) {
			const at = emitted.indexOf(expansion, from);
			if (at === -1) break;
			occurrences++;
			from = at + expansion.length;
		}
		if (occurrences === 0) continue;
		usableHandles++;
		const perOccurrence = expansion.length - (sigil.length + name.length);
		if (perOccurrence > 0) maxSavedChars += occurrences * perOccurrence;
	}
	return {
		emittedChars: emitted.length,
		handles: Object.keys(handles).length,
		usableHandles,
		maxSavedChars,
		maxSavedPct: emitted.length === 0 ? 0 : (100 * maxSavedChars) / emitted.length,
	};
}

/** How much of a repository's vocabulary is in strings a coding agent would ever type. */
export interface TypeableMass {
	/** Handles in the vocabulary. */
	handles: number;
	/** Handles whose expansion contains no whitespace, so an agent could plausibly type it. */
	typeable: number;
	/** Characters saved per emission if every typeable handle were written once: */
	savingPerEmission: number;
	/** {@link savingPerEmission} scaled by {@link OBSERVED_TYPEABLE_EMISSION_RATE}: */
	expectedSavingPerEmission: number;
	/** Longest typeable expansion, the best single substitution available. */
	longestTypeable: number;
}

/** Fraction of typeable handles a run actually emits. */
export const OBSERVED_TYPEABLE_EMISSION_RATE = 8 / 551;

/** Score a vocabulary by how much of it a coding agent could ever actually write. */
export function typeableHandleMass(
	handles: Readonly<Record<string, string>>,
	sigil: string = DEFAULT_SIGIL,
): TypeableMass {
	let typeable = 0;
	let savingPerEmission = 0;
	let longestTypeable = 0;
	for (const [name, expansion] of Object.entries(handles)) {
		if (expansion.length === 0 || /\s/.test(expansion)) continue;
		const saving = expansion.length - (sigil.length + name.length);
		if (saving <= 0) continue;
		typeable++;
		savingPerEmission += saving;
		longestTypeable = Math.max(longestTypeable, expansion.length);
	}
	return {
		handles: Object.keys(handles).length,
		typeable,
		savingPerEmission,
		// Rounded, because a fractional character saved is not a thing and a table
		// of two-decimal character counts invites reading precision that is not
		// there: the rate behind it is a single observation.
		expectedSavingPerEmission: Math.round(savingPerEmission * OBSERVED_TYPEABLE_EMISSION_RATE),
		longestTypeable,
	};
}

/** The run's own noise floor: how much output size varies between REPEATED SAMPLES */
export function withinTaskSpreadPct(rows: readonly ArmResult[]): number | null {
	const byTask = new Map<string, number[]>();
	for (const row of rows) {
		if (row.error || row.outputTokens === null) continue;
		const list = byTask.get(row.task);
		if (list === undefined) byTask.set(row.task, [row.outputTokens]);
		else list.push(row.outputTokens);
	}
	const spreads: number[] = [];
	for (const values of byTask.values()) {
		const spread = relativeSpreadPct(values);
		if (spread !== null) spreads.push(spread);
	}
	if (spreads.length === 0) return null;
	spreads.sort((a, b) => a - b);
	const mid = Math.floor(spreads.length / 2);
	return spreads.length % 2 === 1 ? spreads[mid]! : (spreads[mid - 1]! + spreads[mid]!) / 2;
}

/** Relative spread of a set of values, as a percentage of their mean. */
export function relativeSpreadPct(values: readonly number[]): number | null {
	if (values.length < 2) return null;
	const avg = values.reduce((a, b) => a + b, 0) / values.length;
	if (avg === 0) return null;
	const variance = values.reduce((a, b) => a + (b - avg) ** 2, 0) / (values.length - 1);
	return (100 * Math.sqrt(variance)) / Math.abs(avg);
}

/** Decide whether a run's achievable saving is large enough to be detectable at all. */
export function ceilingBelowNoise(maxSavedPct: number, noisePct: number | null): boolean {
	return maxSavedPct < (noisePct ?? 1);
}

/** Explain what an encode arm's `0 encoded` (or nonzero) result actually means, by */
export function interpretEncodeArm(opts: {
	arm: string;
	okRuns: number;
	taught: number;
	handlesLoaded: number | null;
	encoded: number;
	/** Runs whose refreshed prompt actually carried the handle table; `null` when unrecorded. */
	handlesTaught?: number | null;
	/** Runs that carried an `argot_taught` record at all, the denominator for the above. */
	handlesTaughtKnown?: number;
}): string | null {
	const { arm, okRuns, taught, handlesLoaded, encoded } = opts;
	const handlesTaught = opts.handlesTaught ?? null;
	const handlesTaughtKnown = opts.handlesTaughtKnown ?? 0;
	if (okRuns === 0 || taught === 0) return null;
	if (encoded > 0) {
		const size = handlesLoaded === null ? "an unknown number of" : `${handlesLoaded}`;
		return (
			`**${arm}**: the model encoded in ${encoded}/${okRuns} runs with ${size} handles loaded — ` +
			"the token delta against this arm is a real argot measurement."
		);
	}
	if (handlesLoaded === null) {
		return (
			`**${arm}**: taught the preamble but encoded in 0/${okRuns} runs, and the loaded vocabulary size is ` +
			"UNKNOWN (this run predates the `argot_armed` telemetry). The 0-encoded result is uninterpretable — " +
			"rerun so the loaded handle count is recorded before reading any token delta as an argot effect."
		);
	}
	if (handlesLoaded === 0) {
		return (
			`**${arm}**: taught the preamble but the launch dictionary loaded 0 handles, so encoding was ` +
			"IMPOSSIBLE — this corpus has no repeated-token mass to compress. The token delta against this arm " +
			"is NOT a measure of argot; pick tasks whose repos carry repeated paths/commands to measure encode."
		);
	}
	if (handlesTaughtKnown > 0 && handlesTaught !== null && handlesTaught < handlesTaughtKnown) {
		return (
			`**${arm}**: ${handlesLoaded} handles loaded, but the handle TABLE reached the model in only ` +
			`${handlesTaught}/${handlesTaughtKnown} runs. This is a HARNESS failure, not a model result: a model ` +
			"taught the notation, shown no handles, and instructed never to invent one has no compliant way to " +
			"encode. Fix the arm before reading anything into the 0-encoded rows or the token delta."
		);
	}
	if (handlesTaughtKnown === 0) {
		return (
			`**${arm}**: ${handlesLoaded} handles were loaded and the model encoded in 0/${okRuns} runs, but this ` +
			"run has no `argot_taught` record, so whether the handle table ever REACHED the model is unknown. " +
			"That makes the result unattributable — it is equally consistent with the model declining to encode " +
			"and with the table never being shown. Rerun on a build that records it before drawing a conclusion."
		);
	}
	return (
		`**${arm}**: ${handlesLoaded} handles were loaded AND taught in ${handlesTaught}/${handlesTaughtKnown} runs, ` +
		`yet the model encoded in 0/${okRuns} — it ignored shorthand it could see. This is a model-adoption ` +
		"result (chargeable to the model), not a corpus limit or a harness gap; the token delta reflects the " +
		"model declining to encode, not argot being ineffective."
	);
}

/** Render the full markdown report. `repeats` is passed so the header can state the */
export function renderReport(
	results: readonly ArmResult[],
	model: string,
	nowIso: string,
	repeats = 1,
	taskSet?: TaskSetProvenance,
): string {
	// Sorted for the same reason as pairedByTask: rendering must depend only on the
	// DATA, never on the order rows happened to arrive in.
	const arms = [...new Set(results.map(r => r.arm))].sort();
	const tasks = [...new Set(results.map(r => r.task))].sort();
	const cell = (arm: string, task: string) => results.filter(r => r.arm === arm && r.task === task);
	const lines: string[] = [];
	lines.push(`# DeepSWE bench — ${nowIso}`);
	lines.push("");
	lines.push(`Model: \`${model}\`. Tasks: ${tasks.length}. Repeats/cell: ${repeats}. Arms: ${arms.join(", ")}.`);
	lines.push("");
	// Above the provenance banner on purpose. A selection-biased task set makes the
	// numbers an upper bound; a quota-truncated run makes them not numbers at all,
	// so it is the first thing a reader must see.
	const quotaBanner = renderQuotaTruncationBanner(results);
	if (quotaBanner) {
		lines.push(quotaBanner);
		lines.push("");
	}
	if (taskSet) {
		lines.push(renderTaskSetProvenanceBanner(taskSet));
		lines.push("");
	}
	lines.push("## Per arm totals");
	lines.push("");
	lines.push(
		"| arm | samples | pass rate [95% CI] | mean reward | mean partial | input tok | output tok | cache tok | cost USD | agent wall |",
	);
	lines.push("|---|---|---|---|---|---|---|---|---|---|");
	for (const arm of arms) {
		const s = summarizeCell(results.filter(r => r.arm === arm));
		// Timeouts are inside `n` (they are fails), so they are annotated rather
		// than added: a reader has to be able to see that a cell's fails include
		// runs that never finished, which is a different story from runs that
		// finished and failed.
		const notes: string[] = [];
		if (s.errors > 0) notes.push(`+${s.errors} err`);
		if (s.timedOut > 0) notes.push(`${s.timedOut} timed out`);
		const samples = notes.length > 0 ? `${s.n} (${notes.join(", ")})` : String(s.n);
		lines.push(
			`| ${arm} | ${samples} | ${fmtRate(s)} | ${fmt(s.meanReward, 2)} | ${fmt(s.meanPartial, 2)} | ` +
				`${fmt(s.sumInputTokens)} | ${fmt(s.sumOutputTokens)} | ${fmt(s.sumCacheTokens)} | ` +
				`${fmtCost(s, "sum")} | ${fmt(s.sumAgentSeconds)}s |`,
		);
	}
	// If any arm is unpriced, say so LOUDLY once instead of letting an `unpriced`
	// cell read as an unexplained blank. The provider (a subscription-tier model
	// like google-antigravity flash) reports `cost.total: 0` on every message, so a
	// dollar cost cannot be computed from provider data and the input-for-output
	// tradeoff cannot be weighed at prices. Token columns above still tell the whole
	// physical story; only the money conversion is missing.
	if (arms.some(arm => costIsUnpriced(summarizeCell(results.filter(r => r.arm === arm))))) {
		lines.push("");
		lines.push(
			"> **Cost is `unpriced` for at least one arm.** The provider reported no per-request price " +
				"(`usage.cost.total` is 0 on every message while tokens flowed), so this is a subscription/quota " +
				"model, not a free one. A zero-dollar figure would be fabricated, so cost reads `unpriced`. " +
				"Adjudicate the tradeoff in the reference-cost table below, which prices the same tokens at " +
				"published rates.",
		);
	}
	lines.push("");
	lines.push(renderReferenceCostSection(results, arms));
	lines.push("");
	lines.push(renderPromptCacheInvalidationSection(results, arms));
	lines.push("## Per task");
	lines.push("");
	lines.push(`| task | ${arms.map(a => `${a}: pass | ${a}: mean out tok | ${a}: mean cost`).join(" | ")} |`);
	lines.push(`|---|${arms.map(() => "---|---|---|").join("")}`);
	for (const task of tasks) {
		const cells = arms.flatMap(a => {
			const s = summarizeCell(cell(a, task));
			if (s.total === 0) return ["—", "—", "—"];
			if (s.n === 0) return ["ERR", "—", "—"];
			return [fmtRate(s), fmt(s.meanOutputTokens), fmtCost(s, "mean")];
		});
		lines.push(`| ${task} | ${cells.join(" | ")} |`);
	}
	if (arms.length >= 2) {
		lines.push("");
		// Cells keyed by arm, computed once: three comparison tables below ask the
		// same timeout question and must not each re-derive it (ONE PLACE).
		const armCells = new Map(arms.map(arm => [arm, summarizeCell(results.filter(r => r.arm === arm))]));
		const cellOf = (arm: string): CellSummary => {
			const s = armCells.get(arm);
			if (!s) throw new Error(`internal: no summary for arm ${arm}`);
			return s;
		};
		const timeoutBanner = timeoutAttributionBanner(results, arms);
		if (timeoutBanner) {
			lines.push(timeoutBanner);
			lines.push("");
		}
		lines.push("## Arm comparison (paired by task)");
		lines.push("");
		lines.push(
			"Δ pass rate is arm B minus arm A, averaged over tasks both arms ran. The verdict is a two-sided exact " +
				"sign test over per-task wins/losses (ties excluded); it uses the paired structure, so it has far more " +
				"power than comparing the two arms' independent intervals above. The Δ 95% CI is a normal-approximation " +
				"effect-size aid — at a small task count, trust the sign test. `adj p` is the Holm–Bonferroni-corrected " +
				"p-value across all decisive arm pairs in this run: with k arms there are k(k-1)/2 pairs, so the raw " +
				"p-value manufactures a false winner as the pair count grows. The verdict is decided on `adj p < 0.05`, " +
				"which holds the family-wise false-positive rate at 5% no matter how many arms you compare.",
		);
		lines.push("");
		const armDeltas = pairwiseArmDeltas(results);
		// The family being corrected is the set of pairs that actually ran a test (at
		// least one decisive task); a pair with only ties/unpaired tasks is not a
		// hypothesis and must not inflate the correction factor. Holm is applied to that
		// family and the adjusted p is looked up per row by the ordered A→B key.
		const armTested = armDeltas.filter(d => d.wins + d.losses > 0);
		const armAdj = holmBonferroni(armTested.map(d => d.signTestP));
		const armAdjByPair = new Map(armTested.map((d, i) => [`${d.armA}→${d.armB}`, armAdj[i] as number]));
		// Correctness is compared on THREE metrics, not one, because they answer
		// different questions and a reader has to be able to see them disagree.
		//
		// `reward` is BINARY on the DeepSWE verifier, whatever a reading of the name
		// suggests: it is 1 exactly when every fail-to-pass test passes and 0
		// otherwise. Measured over a full baseline run it took only those two values
		// on all 17 scored tasks. So a reward comparison cannot see a partial-credit
		// regression either, and this block used to claim it could.
		//
		// `partial` is the continuous one. On the same 17 tasks it spread across
		// 0.855, 0.963, 0.974, 0.978, 0.979, 0.981, 0.985, 0.985 and 1.0, and several
		// tasks scoring reward=0 sat one or two failing tests from a full pass. That
		// is where the signal is at twenty tasks: a lever that quietly costs a few
		// percent of correctness moves `partial` long before it flips a single task's
		// pass/fail, and every cost claim here is gated on "no worse".
		//
		// Each is its own Holm family, since a partial-credit drop and a
		// resolved-rate drop are different hypotheses. All three are computed here so
		// the tables below and the efficiency guardrail read the same tested families.
		const rewardDeltas = pairwiseMetricDeltas(results, c => c.meanReward);
		const rewardTested = rewardDeltas.filter(d => d.pos + d.neg > 0);
		const rewardAdj = holmBonferroni(rewardTested.map(d => d.signTestP));
		const rewardAdjByPair = new Map(rewardTested.map((d, i) => [`${d.armA}→${d.armB}`, rewardAdj[i] as number]));
		const partialDeltas = pairwiseMetricDeltas(results, c => c.meanPartial);
		const partialTested = partialDeltas.filter(d => d.pos + d.neg > 0);
		const partialAdj = holmBonferroni(partialTested.map(d => d.signTestP));
		const partialAdjByPair = new Map(partialTested.map((d, i) => [`${d.armA}→${d.armB}`, partialAdj[i] as number]));
		lines.push("| A → B | paired tasks | Δ pass rate | Δ 95% CI | W-L-T | sign-test p | adj p (Holm) | verdict |");
		lines.push("|---|---|---|---|---|---|---|---|");
		for (const d of armDeltas) {
			const delta = d.meanDelta === null ? "—" : (d.meanDelta >= 0 ? "+" : "") + d.meanDelta.toFixed(3);
			const ci =
				d.ciLow === null || d.ciHigh === null
					? "—"
					: `[${(d.ciLow >= 0 ? "+" : "") + d.ciLow.toFixed(3)}, ${(d.ciHigh >= 0 ? "+" : "") + d.ciHigh.toFixed(3)}]`;
			const adjP = armAdjByPair.get(`${d.armA}→${d.armB}`);
			const decisive = adjP !== undefined && adjP < 0.05;
			// A non-significant verdict is only "measured equal" if the run COULD have shown
			// a difference. If even a clean sweep at this decisive-task count can't clear the
			// Holm-adjusted bar, the null is uninformative — say "underpowered" so the reader
			// adds tasks instead of concluding the arms are equivalent.
			const underpowered = !decisive && !sweepCanReachSignificance(d.wins + d.losses, armTested.length);
			// The timeout guard outranks significance: a delta a timeout gap could
			// have produced is not a finding about the arms no matter how small its
			// p-value, so it must not be printed as one.
			const attribution = rewardDeltaAttribution(cellOf(d.armA), cellOf(d.armB), d.meanDelta);
			const verdict = attribution.unattributable
				? TIMEOUT_UNATTRIBUTABLE_VERDICT
				: decisive
					? `${d.meanDelta !== null && d.meanDelta > 0 ? d.armB : d.armA} better (adj p<0.05)`
					: underpowered
						? "not distinguishable (underpowered)"
						: "not distinguishable";
			lines.push(
				`| ${d.armA} → ${d.armB} | ${d.nTasks} | ${delta} | ${ci} | ${d.wins}-${d.losses}-${d.ties} | ${d.signTestP.toFixed(3)} | ${adjP === undefined ? "—" : adjP.toFixed(3)} | ${verdict} |`,
			);
		}

		// Reward table. Both this and the pass rate above are binary on this verifier;
		// they are reported because reward is the headline number. The partial-credit
		// table that follows is the continuous one, and it is what actually catches a
		// regression too small to flip a task.
		const rewardHasSignal = results.some(r => !r.error && r.reward !== null);
		if (rewardHasSignal) {
			lines.push("");
			lines.push("## Reward comparison — continuous partial credit (paired by task)");
			lines.push("");
			lines.push(
				"Reward on the DeepSWE verifier is BINARY: 1 when every fail-to-pass test passes, 0 " +
					"otherwise. It is reported here because it is the headline number, not because it " +
					"adds resolution over the pass-rate table above. For a regression too small to flip " +
					"a task, read the partial-credit table below, which is the continuous one. Δ is B " +
					"minus A on each task's mean reward; a negative Δ the sign test confirms is B doing " +
					"WORSE.",
			);
			lines.push("");
			lines.push(
				"| A → B | paired tasks | Δ mean reward | Δ 95% CI | up-B / down-B / tie | sign-test p | adj p (Holm) | verdict |",
			);
			lines.push("|---|---|---|---|---|---|---|---|");
			for (const d of rewardDeltas) {
				const delta = d.meanDelta === null ? "—" : (d.meanDelta >= 0 ? "+" : "") + d.meanDelta.toFixed(3);
				const ci =
					d.ciLow === null || d.ciHigh === null
						? "—"
						: `[${(d.ciLow >= 0 ? "+" : "") + d.ciLow.toFixed(3)}, ${(d.ciHigh >= 0 ? "+" : "") + d.ciHigh.toFixed(3)}]`;
				const adjP = rewardAdjByPair.get(`${d.armA}→${d.armB}`);
				const sig = adjP !== undefined && adjP < 0.05;
				const rUnderpowered = !sig && !sweepCanReachSignificance(d.pos + d.neg, rewardTested.length);
				// Same guard as the pass-rate table, and it matters more here: a
				// timeout enters the mean reward as a hard zero, so a timeout gap moves
				// this metric directly.
				const rAttribution = rewardDeltaAttribution(cellOf(d.armA), cellOf(d.armB), d.meanDelta);
				const verdict = rAttribution.unattributable
					? TIMEOUT_UNATTRIBUTABLE_VERDICT
					: sig && d.meanDelta !== null && d.meanDelta > 0
						? `${d.armB} higher reward`
						: sig && d.meanDelta !== null && d.meanDelta < 0
							? `${d.armB} lower reward`
							: rUnderpowered
								? "not distinguishable (underpowered)"
								: "not distinguishable";
				lines.push(
					`| ${d.armA} → ${d.armB} | ${d.nTasks} | ${delta} | ${ci} | ${d.pos}/${d.neg}/${d.ties} | ${d.signTestP.toFixed(3)} | ${adjP === undefined ? "—" : adjP.toFixed(3)} | ${verdict} |`,
				);
			}
		}

		// Partial-credit table. This is the only correctness metric on this verifier
		// that is actually continuous, so it is where a small regression shows up first
		// and it is the one the efficiency guardrail most needs.
		const partialHasSignal = results.some(r => !r.error && r.partial !== null);
		if (partialHasSignal) {
			lines.push("");
			lines.push("## Partial-credit comparison — the continuous metric (paired by task)");
			lines.push("");
			lines.push(
				"Both tables above are binary on this verifier, so neither can see a task go from " +
					"98% of its tests passing to 95%. `partial` can: across a full baseline run it " +
					"spread over 0.855, 0.963, 0.974, 0.978, 0.979, 0.981, 0.985, 0.985 and 1.0, and " +
					"several tasks scoring reward=0 were one or two failing tests from a full pass. At " +
					"twenty tasks that is where the resolution is. Δ is B minus A on each task's mean " +
					"partial credit; a negative Δ the sign test confirms is B doing WORSE. The " +
					"efficiency guardrail reads this: 'reward held' requires the pass rate, the reward, " +
					"AND this to not significantly drop.",
			);
			lines.push("");
			lines.push(
				"| A → B | paired tasks | Δ mean partial | Δ 95% CI | up-B / down-B / tie | sign-test p | adj p (Holm) | verdict |",
			);
			lines.push("|---|---|---|---|---|---|---|---|");
			for (const d of partialDeltas) {
				const delta = d.meanDelta === null ? "—" : (d.meanDelta >= 0 ? "+" : "") + d.meanDelta.toFixed(3);
				const ci =
					d.ciLow === null || d.ciHigh === null
						? "—"
						: `[${(d.ciLow >= 0 ? "+" : "") + d.ciLow.toFixed(3)}, ${(d.ciHigh >= 0 ? "+" : "") + d.ciHigh.toFixed(3)}]`;
				const adjP = partialAdjByPair.get(`${d.armA}→${d.armB}`);
				const sig = adjP !== undefined && adjP < 0.05;
				const pUnderpowered = !sig && !sweepCanReachSignificance(d.pos + d.neg, partialTested.length);
				// A timed-out trial scores no partial credit at all and is dropped from
				// the mean rather than entering it as a zero, so an uneven timeout count
				// censors the two arms differently and no p-value repairs that.
				const pAttribution = rewardDeltaAttribution(cellOf(d.armA), cellOf(d.armB), d.meanDelta);
				const verdict = pAttribution.unattributable
					? TIMEOUT_UNATTRIBUTABLE_VERDICT
					: sig && d.meanDelta !== null && d.meanDelta > 0
						? `${d.armB} higher partial credit`
						: sig && d.meanDelta !== null && d.meanDelta < 0
							? `${d.armB} lower partial credit`
							: pUnderpowered
								? "not distinguishable (underpowered)"
								: "not distinguishable";
				lines.push(
					`| ${d.armA} → ${d.armB} | ${d.nTasks} | ${delta} | ${ci} | ${d.pos}/${d.neg}/${d.ties} | ${d.signTestP.toFixed(3)} | ${adjP === undefined ? "—" : adjP.toFixed(3)} | ${verdict} |`,
				);
			}
		}

		// Efficiency comparison. For a feature whose promise is FEWER tokens at equal
		// reward (argot), this is the section that actually measures the claim: a win
		// is a negative paired delta (B cheaper) the sign test confirms, READ WITH the
		// pass-rate table above as a guardrail — cheaper only counts if correctness held.
		const metrics: Array<{
			label: string;
			unit: string;
			of: (c: CellSummary) => number | null;
			raw: (r: ArmResult) => number | null;
			digits: number;
		}> = [
			{ label: "output tok", unit: "tok", of: c => c.meanOutputTokens, raw: r => r.outputTokens, digits: 0 },
			// Input is tested, not merely displayed. A feature can buy shorter output
			// by spending prompt: a larger argot dictionary rides in the prompt every
			// turn. Scoring output alone would score only one side of that trade.
			{ label: "input tok", unit: "tok", of: c => c.meanInputTokens, raw: r => r.inputTokens, digits: 0 },
			{ label: "cost", unit: "$", of: c => c.meanCostUsd, raw: r => r.costUsd, digits: 4 },
			// Reference cost, and it is the row that matters. The provider prices
			// nothing, so the `cost` row above is uniformly zero and correctly reports
			// itself unmeasured, which left the ONLY statistically valid comparison
			// this bench makes unable to see cost at all. Every cost claim made from
			// this bench was therefore read off the per-arm SUM table, which pairs
			// nothing and controls for nothing: a +4.5% "result" there sat inside a
			// per-task noise band of +-30% and was reported as definitive.
			//
			// Priced per run from the same rate card as the totals table, so cost gets
			// a paired sign test and a confidence interval like every other metric.
			{
				label: "ref cost",
				unit: "$",
				of: c => (c.refCostMeasurable ? c.refCost.total / Math.max(1, c.n) : null),
				raw: r =>
					r.cacheReadTokens == null || r.cacheWriteTokens == null
						? null
						: priceTokens({
								inputTokens: r.inputTokens ?? 0,
								cacheReadTokens: r.cacheReadTokens,
								cacheWriteTokens: r.cacheWriteTokens,
								outputTokens: r.outputTokens ?? 0,
							}).total,
				digits: 4,
			},
		];
		lines.push("");
		lines.push("## Efficiency comparison (paired by task)");
		lines.push("");
		lines.push(
			"Δ is arm B minus arm A on the per-task mean, over tasks both arms ran. A negative Δ means B is cheaper. " +
				"The verdict pairs the sign test on this metric with the pass-rate guardrail: B is an efficiency win only " +
				"when it is significantly cheaper (Holm-adjusted p<0.05 within this metric's pairs) AND the pass-rate " +
				"comparison above did not find B worse (also on the Holm-adjusted p). `adj p` is corrected across this " +
				"metric's arm pairs for the same reason the pass-rate table is.",
		);
		lines.push("");
		lines.push(
			"| metric | A → B | paired tasks | Δ mean | Δ 95% CI | cheaper-B / dearer-B / tie | sign-test p | adj p (Holm) | verdict |",
		);
		lines.push("|---|---|---|---|---|---|---|---|---|");
		for (const m of metrics) {
			// A metric the provider never reports (e.g. cost is 0 for a provider with no
			// pricing entry) is uniformly 0/null across every OK sample. Its paired delta
			// is then 0 with p=1, which the loop below would render as "not
			// distinguishable" — reading as "measured and found equal" when it was never
			// measured at all. Detect the no-signal case and say so, so a missing metric
			// is never mistaken for a null result.
			const hasSignal = results.some(r => !r.error && (m.raw(r) ?? 0) !== 0);
			if (!hasSignal) {
				// For cost specifically, all-zero has a precise name — the model is
				// UNPRICED (a subscription tier the provider never billed per request),
				// not merely "not reported". Use the same word the per-arm totals table
				// uses (see fmtCost), so a reader cannot see `unpriced` in one section and
				// a differently-worded blank in another and wonder if they mean the same
				// thing. For token metrics, all-zero really is a provider that did not
				// report the count, so keep that wording.
				const why =
					m.label === "cost"
						? "not measured (cost unpriced — provider reported no price)"
						: "not measured (all 0/null for this provider)";
				lines.push(`| ${m.label} | — | — | — | — | — | — | — | ${why} |`);
				continue;
			}
			// Each metric is its own family of arm-pair tests, corrected independently.
			const metricDeltas = pairwiseMetricDeltas(results, m.of);
			const metricTested = metricDeltas.filter(d => d.pos + d.neg > 0);
			const metricAdj = holmBonferroni(metricTested.map(d => d.signTestP));
			const metricAdjByPair = new Map(metricTested.map((d, i) => [`${d.armA}→${d.armB}`, metricAdj[i] as number]));
			for (const d of metricDeltas) {
				const dv = (x: number) => (m.digits > 0 ? x.toFixed(m.digits) : String(Math.round(x)));
				const delta = d.meanDelta === null ? "—" : (d.meanDelta >= 0 ? "+" : "") + dv(d.meanDelta);
				const ci =
					d.ciLow === null || d.ciHigh === null
						? "—"
						: `[${(d.ciLow >= 0 ? "+" : "") + dv(d.ciLow)}, ${(d.ciHigh >= 0 ? "+" : "") + dv(d.ciHigh)}]`;
				const cheaperB = d.neg; // B < A on this cost metric
				const dearerB = d.pos;
				const adjP = metricAdjByPair.get(`${d.armA}→${d.armB}`);
				const sig = adjP !== undefined && adjP < 0.05;
				const cheaperSig = sig && d.meanDelta !== null && d.meanDelta < 0;
				// The guardrail: B is not worse on correctness — its pass-rate comparison is
				// not a significant loss for B, judged on the SAME Holm-adjusted standard as
				// the pass-rate table's own verdict (so the two sections cannot disagree).
				const passAdj = armAdjByPair.get(`${d.armA}→${d.armB}`);
				const passDelta = armDeltas.find(a => a.armA === d.armA && a.armB === d.armB)?.meanDelta ?? null;
				const binaryHeld = !(passAdj !== undefined && passAdj < 0.05 && passDelta !== null && passDelta < 0);
				// Reward held on the CONTINUOUS metric too: a partial-credit regression that
				// leaves the binary rate untouched must still veto a "cheaper" win, or the
				// "equal reward" half of argot's claim is not actually being checked.
				const rewardAdj = rewardAdjByPair.get(`${d.armA}→${d.armB}`);
				const rewardDelta = rewardDeltas.find(a => a.armA === d.armA && a.armB === d.armB)?.meanDelta ?? null;
				const rewardHeld = !(
					rewardAdj !== undefined &&
					rewardAdj < 0.05 &&
					rewardDelta !== null &&
					rewardDelta < 0
				);
				// And on partial credit, which is the only one of the three that is
				// actually continuous on this verifier. Without this the guardrail is two
				// spellings of the same binary question and a small correctness loss ships
				// as "cheaper, reward held".
				const partialAdjP = partialAdjByPair.get(`${d.armA}→${d.armB}`);
				const partialDelta = partialDeltas.find(a => a.armA === d.armA && a.armB === d.armB)?.meanDelta ?? null;
				const partialHeld = !(
					partialAdjP !== undefined &&
					partialAdjP < 0.05 &&
					partialDelta !== null &&
					partialDelta < 0
				);
				const passHeld = binaryHeld && rewardHeld && partialHeld;
				// Same honesty guard as the pass-rate table: a non-significant efficiency
				// delta is only a real null if a clean sweep at this decisive-task count could
				// have cleared the Holm bar for this metric's family. Otherwise flag it.
				const effUnderpowered = !sig && !sweepCanReachSignificance(d.pos + d.neg, metricTested.length);
				// A timed-out trial records no tokens, so it is dropped from these
				// means, and the dropped runs are the slowest ones. Any gap in how many
				// each arm dropped means the two means were censored differently, which
				// no p-value repairs.
				const effAttribution = efficiencyDeltaAttribution(cellOf(d.armA), cellOf(d.armB));
				const verdict = effAttribution.unattributable
					? TIMEOUT_UNATTRIBUTABLE_VERDICT
					: cheaperSig
						? passHeld
							? `${d.armB} cheaper, reward held`
							: `${d.armB} cheaper BUT reward dropped`
						: sig && d.meanDelta !== null && d.meanDelta > 0
							? `${d.armB} dearer`
							: effUnderpowered
								? "not distinguishable (underpowered)"
								: "not distinguishable";
				lines.push(
					`| ${m.label} | ${d.armA} → ${d.armB} | ${d.nTasks} | ${delta} ${m.unit} | ${ci} | ${cheaperB}/${dearerB}/${d.ties} | ${d.signTestP.toFixed(3)} | ${adjP === undefined ? "—" : adjP.toFixed(3)} | ${verdict} |`,
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
			r =>
				r.argotLoadCalls !== null ||
				r.assistantMsgsWithSigil !== null ||
				r.argotPreamblePresent !== null ||
				r.argotHandlesLoaded !== null ||
				r.argotHandlesTaught !== null,
		),
	);
	if (argotArms.length > 0) {
		lines.push("");
		lines.push("## Argot treatment applied? (per arm)");
		lines.push("");
		lines.push(
			"`preamble taught` is the authoritative signal that the treatment REACHED the model: it reads the " +
				"actual system prompt, so it reflects the model AFTER catalog id resolution. An encode arm whose " +
				"`preamble taught` is `0/N` never fired the treatment (a silent degrade to decode-only). But teaching " +
				"is NOT sufficient — `vocab handles` is the launch dictionary's actual size, and encode is only " +
				"POSSIBLE when it is above zero. `0` handles means the corpus has no repeated-token mass, so a " +
				"`0 encoded` result there measures nothing about argot. `—` handles means the run predates the " +
				"telemetry, so its 0-encoded is uninterpretable. Read the per-arm interpretation below the table.",
		);
		lines.push("");
		lines.push(
			"`handles taught` is the column that decides who a `0 encoded` result belongs to. Loading a " +
				"dictionary and teaching the notation both happen at startup; putting the actual handle TABLE in " +
				"front of the model happens later, on an asynchronous prompt refresh that no recorded prompt " +
				"captures. So `handles taught` reads the SDK's own post-refresh record. `N/N` means the model " +
				"genuinely saw the handles and a `0 encoded` row is its own choice. Anything less is a HARNESS " +
				"failure: the model was taught notation, shown no handles, and told never to invent one, so zero " +
				"was the only compliant output and the trial measures nothing about adoption.",
		);
		lines.push("");
		lines.push(
			"| arm | OK runs | preamble taught | vocab handles | handles taught | mean argot_load calls | mean msgs with § | runs that encoded (§>0) |",
		);
		lines.push("|---|---|---|---|---|---|---|---|");
		const interpretations: string[] = [];
		for (const a of argotArms) {
			const rows = okByArm(a);
			const encoded = rows.filter(r => (r.assistantMsgsWithSigil ?? 0) > 0).length;
			const taught = rows.filter(r => r.argotPreamblePresent === true).length;
			const known = rows.filter(r => r.argotPreamblePresent !== null).length;
			const taughtCell = known === 0 ? "unknown" : `${taught}/${known}`;
			// The loaded handle count is a per-repo property, so across a single task's
			// repeats it is constant; the max over OK rows recovers it even if a stray
			// row lacked the record (null), and stays null only when EVERY row lacked it.
			const handleVals = rows.map(r => r.argotHandlesLoaded).filter((h): h is number => h !== null);
			const handlesLoaded = handleVals.length === 0 ? null : Math.max(...handleVals);
			const handlesCell = handlesLoaded === null ? "—" : `${handlesLoaded}`;
			const tableTaught = rows.filter(r => r.argotHandlesTaught === true).length;
			const tableKnown = rows.filter(r => r.argotHandlesTaught !== null).length;
			const tableCell = tableKnown === 0 ? "—" : `${tableTaught}/${tableKnown}`;
			lines.push(
				`| ${a} | ${rows.length} | ${taughtCell} | ${handlesCell} | ${tableCell} | ${fmt(mean(rows.map(r => r.argotLoadCalls)), 2)} | ` +
					`${fmt(mean(rows.map(r => r.assistantMsgsWithSigil)), 2)} | ${encoded}/${rows.length} |`,
			);
			const note = interpretEncodeArm({
				arm: a,
				okRuns: rows.length,
				taught,
				handlesLoaded,
				encoded,
				handlesTaught: tableKnown === 0 ? null : tableTaught,
				handlesTaughtKnown: tableKnown,
			});
			if (note !== null) interpretations.push(note);
		}
		if (interpretations.length > 0) {
			lines.push("");
			for (const note of interpretations) lines.push(`- ${note}`);
		}
	}
	// Effect-size ceiling. This section answers a question the significance tests
	// structurally cannot: not "did we see a difference" but "could a difference
	// large enough to see have existed at all on this workload". A run whose ceiling
	// sits under its own noise is unmeasurable no matter how many repeats it gets.
	const headroomArms = arms.filter(a => okByArm(a).some(r => r.encodeHeadroom !== null));
	if (headroomArms.length > 0) {
		lines.push("");
		lines.push("## Encode headroom — the maximum saving that was ever available");
		lines.push("");
		lines.push(
			"`max saving` is what shorthand would have saved if the model had encoded PERFECTLY: every " +
				"occurrence of every loaded handle's expansion, in text and in tool-call arguments, written as the " +
				"handle instead. It is an upper bound the feature cannot beat on this workload. `noise` is the " +
				"observed run-to-run spread of output tokens across repeated samples of the same arm and task, which " +
				"is the smallest difference this run could distinguish from chance. When the ceiling is below the " +
				"noise, the efficiency comparison above is measuring variance and NOTHING can be concluded about the " +
				"feature — more repeats cannot help, because the effect being sought is smaller than the effect that " +
				"exists. Fix the workload (tasks whose repos repeat long paths and commands the agent actually " +
				"retypes) or the vocabulary, not the sample count.",
		);
		lines.push("");
		lines.push(
			"| arm | emitted chars | handles | handles ever emitted | max saving | max saving % | noise % | verdict |",
		);
		lines.push("|---|---|---|---|---|---|---|---|");
		for (const a of headroomArms) {
			const rows = okByArm(a).filter(r => r.encodeHeadroom !== null);
			const emitted = rows.reduce((s, r) => s + (r.encodeHeadroom?.emittedChars ?? 0), 0);
			const saved = rows.reduce((s, r) => s + (r.encodeHeadroom?.maxSavedChars ?? 0), 0);
			const handles = Math.max(...rows.map(r => r.encodeHeadroom?.handles ?? 0));
			const usable = Math.max(...rows.map(r => r.encodeHeadroom?.usableHandles ?? 0));
			const pct = emitted === 0 ? 0 : (100 * saved) / emitted;
			// Noise is estimated WITHIN each task, then combined. Pooling an arm's
			// samples across tasks would measure task difficulty rather than chance,
			// and that inflated floor would declare a genuinely measurable run
			// unmeasurable. Only repeats of the same task differ by nothing else.
			const noise = withinTaskSpreadPct(okByArm(a));
			const verdict = ceilingBelowNoise(pct, noise)
				? "**CANNOT MEASURE** — ceiling below noise; any delta here is variance"
				: "measurable — the ceiling exceeds this run's noise";
			lines.push(
				`| ${a} | ${emitted} | ${handles} | ${usable} | ${saved} | ${pct.toFixed(2)}% | ` +
					`${noise === null ? "—" : `${noise.toFixed(2)}%`} | ${verdict} |`,
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
		// MEAN calls per completed run, not raw per-arm totals: arms rarely have the same

		// merely ran less. Dividing by each arm's completed-run count `n` (shown per row)
		// makes the columns comparable across arms, which is the whole point of the table.
		lines.push("## Tool call distribution (mean calls per completed run)");
		lines.push("");
		lines.push(`| arm | ${allTools.join(" | ")} |`);
		lines.push(`|---|${allTools.map(() => "---|").join("")}`);
		for (const arm of arms) {
			const rows = results.filter(r => r.arm === arm && !r.error);
			const n = rows.length;
			const cells = allTools.map(t =>
				n === 0 ? "—" : fmt(rows.reduce((acc, r) => acc + (r.toolCalls?.[t] ?? 0), 0) / n, 2),
			);
			lines.push(`| ${arm} (n=${n}) | ${cells.join(" | ")} |`);
		}
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}

// Pooling several runs into one comparison

/** One run's contribution to a pooled comparison, read from its `results.json`. */
export interface RunToMerge {
	/** Where it came from, used only to name the offending run in a refusal. */
	readonly label: string;
	readonly model: string;
	readonly binarySha: string | null;
	/** Arm name to config fingerprint, so an arm that changed meaning is caught. */
	readonly armFingerprints: Record<string, string> | null;
	readonly results: readonly ArmResult[];
}

/** Why a set of runs cannot be pooled. Refusing is the point: every rule below */
export class MergeRefused extends Error {}

/** Pool several runs into one set of paired results. */
export function mergeRuns(runs: readonly RunToMerge[]): { results: ArmResult[]; model: string } {
	if (runs.length === 0) throw new MergeRefused("no runs to merge");

	const models = [...new Set(runs.map(r => r.model))];
	if (models.length > 1) {
		throw new MergeRefused(
			`runs use different models (${models.join(", ")}). Pooling them would average two ` +
				`providers into one number that describes neither.`,
		);
	}

	// Every run must carry the same arms. A run missing an arm contributes unpaired
	// tasks, and the day effect then lands on whichever arm is present.
	const armsOf = (run: RunToMerge) => [...new Set(run.results.map(r => r.arm))].sort();
	const reference = armsOf(runs[0]!);
	for (const run of runs.slice(1)) {
		const arms = armsOf(run);
		if (arms.join(" ") !== reference.join(" ")) {
			throw new MergeRefused(
				`run "${run.label}" has arms [${arms.join(", ")}] but "${runs[0]!.label}" has ` +
					`[${reference.join(", ")}]. Pooling runs with different arms compares a day ` +
					`against an arm: every task from the odd run out is unpaired, so the provider's ` +
					`condition that day is attributed to whichever arm happened to run.`,
			);
		}
	}

	const shas = [...new Set(runs.map(r => r.binarySha).filter(sha => sha !== null))];
	if (shas.length > 1) {
		throw new MergeRefused(
			`runs were produced by different binaries (${shas.join(", ")}). The delta would ` +
				`include whatever else changed in the build, not just the arm.`,
		);
	}

	// The most dangerous case, and one a reader would never spot: the same arm NAME
	// pointing at a different config in two runs. The pooled report would then label
	// two different treatments with one name and average them.
	for (const arm of reference) {
		const fingerprints = [...new Set(runs.map(r => r.armFingerprints?.[arm]).filter(f => f !== undefined))];
		if (fingerprints.length > 1) {
			throw new MergeRefused(
				`arm "${arm}" has different configs across runs (${fingerprints.join(", ")}). ` +
					`The name means two different treatments, and pooling would average them ` +
					`under one label.`,
			);
		}
	}

	const seen = new Map<string, number>();
	const results: ArmResult[] = [];
	for (const run of runs) {
		for (const result of [...run.results].sort(
			(a, b) => a.arm.localeCompare(b.arm) || a.task.localeCompare(b.task) || a.repeat - b.repeat,
		)) {
			const cell = `${result.arm} ${result.task}`;
			const next = seen.get(cell) ?? 0;
			seen.set(cell, next + 1);
			results.push({ ...result, repeat: next });
		}
	}
	results.sort((a, b) => a.arm.localeCompare(b.arm) || a.task.localeCompare(b.task) || a.repeat - b.repeat);
	return { results, model: models[0]! };
}

/** One queued trial: a single (arm, task, repeat) cell to run. */
export interface QueuedTrial {
	readonly arm: string;
	readonly task: string;
	readonly repeat: number;
}

/** The order trials are run in, which decides what survives when a run is cut short. */
export function trialQueue(arms: readonly string[], tasks: readonly string[], repeats: number): QueuedTrial[] {
	const queue: QueuedTrial[] = [];
	for (const task of tasks) {
		for (let repeat = 0; repeat < repeats; repeat++) {
			for (const arm of arms) queue.push({ arm, task, repeat });
		}
	}
	return queue;
}

/** A lever's predicted saving set against what the run actually billed. */
export interface PredictedVsActual {
	readonly predicted: number;
	readonly actual: number;
	readonly gap: number;
	readonly baselineCost: number;
	readonly treatmentCost: number;
}

/** Price both arms of a run at reference rates and compare the measured saving */
/** Whether a trial actually put tokens on the wire. */
function wasBilled(result: ArmResult): boolean {
	const prompt = (result.inputTokens ?? 0) + (result.cacheReadTokens ?? 0) + (result.cacheWriteTokens ?? 0);
	return result.inputTokens !== null && prompt > 0;
}

export function predictedVsActual(
	results: readonly ArmResult[],
	baselineArm: string,
	treatmentArm: string,
	predicted: number,
	rates: RateCard = REFERENCE_RATE_CARD,
): PredictedVsActual | null {
	const costOf = (arm: string): number | null => {
		const rows = results.filter(r => r.arm === arm && wasBilled(r));
		if (rows.length === 0) return null;
		const mix: TokenMix = {
			inputTokens: rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
			cacheReadTokens: rows.reduce((s, r) => s + (r.cacheReadTokens ?? 0), 0),
			cacheWriteTokens: rows.reduce((s, r) => s + (r.cacheWriteTokens ?? 0), 0),
			outputTokens: rows.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
		};
		return priceTokens(mix, rates).total;
	};
	const baselineCost = costOf(baselineArm);
	const treatmentCost = costOf(treatmentArm);
	if (baselineCost === null || treatmentCost === null || baselineCost <= 0) return null;
	const actual = (baselineCost - treatmentCost) / baselineCost;
	return { predicted, actual, gap: actual - predicted, baselineCost, treatmentCost };
}

/** Only compare arms over the tasks BOTH of them completed. */
export function onPairedTasks(results: readonly ArmResult[], armA: string, armB: string): ArmResult[] {
	const tasksOf = (arm: string) => new Set(results.filter(r => r.arm === arm && wasBilled(r)).map(r => r.task));
	const a = tasksOf(armA);
	const b = tasksOf(armB);
	const shared = new Set([...a].filter(task => b.has(task)));
	return results.filter(r => shared.has(r.task) && (r.arm === armA || r.arm === armB));
}
