import { ARGOT_PREAMBLE, DEFAULT_SIGIL } from "argot";
import { type CostBreakdown, costShares, priceTokens, REFERENCE_RATE_CARD } from "./cost-model";

export const ARGOT_PREAMBLE_HEADING: string = ARGOT_PREAMBLE.split("\n", 1)[0] ?? "";

export function systemPromptTeachesArgot(systemPrompt: string): boolean {
	if (ARGOT_PREAMBLE_HEADING === "") return false;
	return systemPrompt.includes(ARGOT_PREAMBLE_HEADING);
}

export function blockContainsSigil(block: unknown, sigil: string = DEFAULT_SIGIL): boolean {
	if (typeof block !== "object" || block === null) return false;
	const b = block as Record<string, unknown>;
	if (typeof b.text === "string" && b.text.includes(sigil)) return true;
	if (b.type === "toolCall" && b.arguments !== undefined) {
		try {
			return JSON.stringify(b.arguments).includes(sigil);
		} catch {
			return false;
		}
	}
	return false;
}

export interface SessionUsage {
	inputTokens: number;
	outputTokens: number;
	cacheTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
	argotLoadCalls: number;
	assistantMsgsWithSigil: number;
	toolCalls: Record<string, number>;
}

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

export function providerFinishReason(text: string): string | null {
	const m = text.match(/finish[ _]reason:?\s*([A-Z][A-Z_]{2,})/);
	return m ? (m[1] as string) : null;
}

export interface ProviderQuotaStop {
	resetAt: string | null;
	model: string | null;
}

export function providerQuotaStop(text: string | null | undefined): ProviderQuotaStop | null {
	if (!text) return null;
	if (!/RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED/.test(text)) return null;
	const resetAt = text.match(/"quotaResetTimeStamp":\s*"([^"]+)"/)?.[1] ?? text.match(/resets_at=(\S+)/)?.[1] ?? null;
	const model = text.match(/"model":\s*"([^"]+)"/)?.[1] ?? text.match(/quota_model=(\S+)/)?.[1] ?? null;
	return { resetAt, model };
}

export function quotaStopMarker(stop: ProviderQuotaStop): string {
	const parts = ["QUOTA_EXHAUSTED"];
	if (stop.resetAt) parts.push(`resets_at=${stop.resetAt}`);
	if (stop.model) parts.push(`quota_model=${stop.model}`);
	return parts.join(" ");
}

export const NO_REWARD_ERROR = "verifier produced no reward: missing verifier_result.rewards.reward";

export function noRewardError(reward: number | null): boolean {
	return !Number.isFinite(reward ?? Number.NaN);
}

export function isAgentTimeout(error: string | null): boolean {
	if (error === null) return false;
	return /trial timed out after \d+s/i.test(error) || error.includes("AgentTimeoutError");
}

export const NO_PATCH_IN_CONTAINER = "Could not find the file /logs/artifacts/model.patch in container";

export const CANCELLATION_MARKERS = ["KeyboardInterrupt", "CancelledError", "AgentTimeoutError"] as const;

export function finishedWithoutPatch(traceback: string | null | undefined): boolean {
	if (!traceback) return false;
	if (!traceback.includes(NO_PATCH_IN_CONTAINER)) return false;
	return !CANCELLATION_MARKERS.some(marker => traceback.includes(marker));
}

export function isHardError(result: { error: string | null; outputTokens: number | null }): boolean {
	if (isAgentTimeout(result.error)) return false;
	return result.error !== null && result.outputTokens === null;
}

export function shouldTripCanary(
	results: ReadonlyArray<{ error: string | null; outputTokens: number | null }>,
	canarySize: number,
): boolean {
	return results.length >= canarySize && results.length > 0 && results.every(isHardError);
}

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
	if (error.includes(NO_REWARD_ERROR)) return "verifier-no-reward";
	const finish = providerFinishReason(error);
	let base = "other";
	const typeMatch = error.match(/"exception_type"\s*:\s*"([^"]+)"/);
	if (typeMatch) {
		base = typeMatch[1] as string;
	} else if (/timed out/i.test(error)) {
		base = "timeout";
	}
	return finish ? `${base} (${finish})` : base;
}

export function jobNameOf(arm: string, task: string, repeat: number, repeats: number): string {
	return repeats > 1 ? `${arm}__${task}__r${repeat}` : `${arm}__${task}`;
}

export function selectTasks(sorted: readonly string[], limit: number | undefined): string[] {
	if (limit === undefined || limit >= sorted.length) return [...sorted];
	if (limit <= 0) return [];
	const out: string[] = [];
	for (let i = 0; i < limit; i++) {
		out.push(sorted[Math.floor((i * sorted.length) / limit)] as string);
	}
	return out;
}

export interface TaskSetProvenance {
	marked: boolean;
	biased: boolean;
	note: string | null;
}

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
	repeat: number;
	reward: number | null;
	partial: number | null;
	f2p: number | null;
	p2p: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
	cacheTokens: number | null;
	cacheReadTokens: number | null;
	cacheWriteTokens: number | null;
	promptCacheInvalidations: string[] | null;
	costUsd: number | null;
	agentSeconds: number | null;
	argotLoadCalls: number | null;
	assistantMsgsWithSigil: number | null;
	argotPreamblePresent: boolean | null;
	argotHandlesLoaded: number | null;
	argotHandlesTaught: boolean | null;
	encodeHeadroom: EncodeHeadroom | null;
	toolCalls: Record<string, number> | null;
	error: string | null;
}

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

export interface CellSummary {
	total: number;
	errors: number;
	timedOut: number;
	n: number;
	passes: number;
	passRate: number | null;
	stdErr: number | null;
	wilsonLow: number | null;
	wilsonHigh: number | null;
	meanReward: number | null;
	meanPartial: number | null;
	meanOutputTokens: number | null;
	meanInputTokens: number | null;
	meanCostUsd: number | null;
	sumOutputTokens: number;
	sumCostUsd: number;
	sumInputTokens: number;
	sumCacheTokens: number;
	sumAgentSeconds: number;
	costPriced: boolean;
	refCost: CostBreakdown;
	refCostMeasurable: boolean;
}

export function mean(values: Array<number | null>): number | null {
	const nums = values.filter((v): v is number => v !== null && v !== undefined);
	if (nums.length === 0) return null;
	return nums.reduce((a, v) => a + v, 0) / nums.length;
}

export const PINNED_TEMPERATURE = 0;

export function effectiveTemperature(config: unknown, pinned: number = PINNED_TEMPERATURE): number {
	if (config !== null && typeof config === "object" && "temperature" in config) {
		const t = (config as { temperature: unknown }).temperature;
		if (typeof t === "number" && Number.isFinite(t) && t >= 0) return t;
	}
	return pinned;
}

export const Z_95 = 1.959963984540054;

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

export function signTestPValue(wins: number, losses: number): number {
	const n = wins + losses;
	if (n <= 0) return 1;
	const k = Math.min(wins, losses);
	let pmf = 0.5 ** n;
	let cdf = pmf;
	for (let i = 1; i <= k; i++) {
		pmf *= (n - i + 1) / i;
		cdf += pmf;
	}
	return Math.min(1, 2 * cdf);
}

export function sweepCanReachSignificance(nDecisive: number, familySize: number, alpha = 0.05): boolean {
	if (nDecisive <= 0) return false;
	const bestCaseRaw = signTestPValue(nDecisive, 0);
	const bestCaseAdjusted = Math.min(1, bestCaseRaw * Math.max(1, familySize));
	return bestCaseAdjusted < alpha;
}

export function holmBonferroni(pValues: readonly number[]): number[] {
	const m = pValues.length;
	if (m === 0) return [];
	const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
	const adjusted = new Array<number>(m);
	let running = 0;
	order.forEach((entry, rank) => {
		const val = Math.min(1, entry.p * (m - rank));
		running = Math.max(running, val);
		adjusted[entry.i] = running;
	});
	return adjusted;
}

export interface ArmDelta {
	armA: string;
	armB: string;
	nTasks: number;
	meanDelta: number | null;
	ciLow: number | null;
	ciHigh: number | null;
	wins: number;
	losses: number;
	ties: number;
	signTestP: number;
}

export interface PairedComparison {
	armA: string;
	armB: string;
	nTasks: number;
	meanDelta: number | null;
	ciLow: number | null;
	ciHigh: number | null;
	pos: number;
	neg: number;
	ties: number;
	signTestP: number;
}

export function pairedByTask(
	results: readonly ArmResult[],
	metricOf: (cell: CellSummary) => number | null,
): PairedComparison[] {
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

export function pairwiseMetricDeltas(
	results: readonly ArmResult[],
	metric: (cell: CellSummary) => number | null,
): PairedComparison[] {
	return pairedByTask(results, metric);
}

export function summarizeCell(rows: readonly ArmResult[]): CellSummary {
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
		refCostMeasurable: ok.length > 0 && ok.every(r => r.cacheReadTokens != null && r.cacheWriteTokens != null),
	};
}

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

export function costIsUnpriced(s: CellSummary): boolean {
	return !s.costPriced && s.sumOutputTokens > 0;
}

export function timeoutRate(s: CellSummary): number | null {
	return s.n === 0 ? null : s.timedOut / s.n;
}

export interface TimeoutAttribution {
	readonly timedOutA: number;
	readonly timedOutB: number;
	readonly rateA: number | null;
	readonly rateB: number | null;
	readonly rateGap: number | null;
	readonly unattributable: boolean;
}

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
	if (observedDelta === null) return { ...base, unattributable: false };
	return { ...base, unattributable: rateGap >= Math.abs(observedDelta) };
}

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

export const TIMEOUT_UNATTRIBUTABLE_VERDICT = "not attributable (timeout gap)";

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

export function fmtCost(s: CellSummary, kind: "sum" | "mean"): string {
	if (costIsUnpriced(s)) return kind === "sum" ? "unpriced" : "—";
	const value = kind === "sum" ? s.sumCostUsd : s.meanCostUsd;
	if (value === null) return "—";
	return `$${value.toFixed(3)}`;
}

export function fmt(n: number | null, digits = 0): string {
	if (n === null || n === undefined) return "—";
	return digits > 0 ? n.toFixed(digits) : String(Math.round(n));
}

export function fmtRate(s: CellSummary): string {
	if (s.passRate === null) return "—";
	const ci =
		s.wilsonLow === null || s.wilsonHigh === null ? "" : ` [${s.wilsonLow.toFixed(2)}–${s.wilsonHigh.toFixed(2)}]`;
	return `${s.passRate.toFixed(2)}${ci} (${s.passes}/${s.n})`;
}

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
				} catch {}
			}
		}
	}
	return parts.join("\n");
}

export interface EncodeHeadroom {
	emittedChars: number;
	handles: number;
	usableHandles: number;
	maxSavedChars: number;
	maxSavedPct: number;
}

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

export interface TypeableMass {
	handles: number;
	typeable: number;
	savingPerEmission: number;
	expectedSavingPerEmission: number;
	longestTypeable: number;
}

export const OBSERVED_TYPEABLE_EMISSION_RATE = 8 / 551;

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
		expectedSavingPerEmission: Math.round(savingPerEmission * OBSERVED_TYPEABLE_EMISSION_RATE),
		longestTypeable,
	};
}

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

export function relativeSpreadPct(values: readonly number[]): number | null {
	if (values.length < 2) return null;
	const avg = values.reduce((a, b) => a + b, 0) / values.length;
	if (avg === 0) return null;
	const variance = values.reduce((a, b) => a + (b - avg) ** 2, 0) / (values.length - 1);
	return (100 * Math.sqrt(variance)) / Math.abs(avg);
}

export function ceilingBelowNoise(maxSavedPct: number, noisePct: number | null): boolean {
	return maxSavedPct < (noisePct ?? 1);
}

export function interpretEncodeArm(opts: {
	arm: string;
	okRuns: number;
	taught: number;
	handlesLoaded: number | null;
	encoded: number;
	handlesTaught?: number | null;
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

export function renderReport(
	results: readonly ArmResult[],
	model: string,
	nowIso: string,
	repeats = 1,
	taskSet?: TaskSetProvenance,
): string {
	const arms = [...new Set(results.map(r => r.arm))].sort();
	const tasks = [...new Set(results.map(r => r.task))].sort();
	const cell = (arm: string, task: string) => results.filter(r => r.arm === arm && r.task === task);
	const lines: string[] = [];
	lines.push(`# DeepSWE bench — ${nowIso}`);
	lines.push("");
	lines.push(`Model: \`${model}\`. Tasks: ${tasks.length}. Repeats/cell: ${repeats}. Arms: ${arms.join(", ")}.`);
	lines.push("");
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
		const armTested = armDeltas.filter(d => d.wins + d.losses > 0);
		const armAdj = holmBonferroni(armTested.map(d => d.signTestP));
		const armAdjByPair = new Map(armTested.map((d, i) => [`${d.armA}→${d.armB}`, armAdj[i] as number]));
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
			const underpowered = !decisive && !sweepCanReachSignificance(d.wins + d.losses, armTested.length);
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

		const metrics: Array<{
			label: string;
			unit: string;
			of: (c: CellSummary) => number | null;
			raw: (r: ArmResult) => number | null;
			digits: number;
		}> = [
			{ label: "output tok", unit: "tok", of: c => c.meanOutputTokens, raw: r => r.outputTokens, digits: 0 },
			{ label: "input tok", unit: "tok", of: c => c.meanInputTokens, raw: r => r.inputTokens, digits: 0 },
			{ label: "cost", unit: "$", of: c => c.meanCostUsd, raw: r => r.costUsd, digits: 4 },
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
			const hasSignal = results.some(r => !r.error && (m.raw(r) ?? 0) !== 0);
			if (!hasSignal) {
				const why =
					m.label === "cost"
						? "not measured (cost unpriced — provider reported no price)"
						: "not measured (all 0/null for this provider)";
				lines.push(`| ${m.label} | — | — | — | — | — | — | — | ${why} |`);
				continue;
			}
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
				const passAdj = armAdjByPair.get(`${d.armA}→${d.armB}`);
				const passDelta = armDeltas.find(a => a.armA === d.armA && a.armB === d.armB)?.meanDelta ?? null;
				const binaryHeld = !(passAdj !== undefined && passAdj < 0.05 && passDelta !== null && passDelta < 0);
				const rewardAdj = rewardAdjByPair.get(`${d.armA}→${d.armB}`);
				const rewardDelta = rewardDeltas.find(a => a.armA === d.armA && a.armB === d.armB)?.meanDelta ?? null;
				const rewardHeld = !(
					rewardAdj !== undefined &&
					rewardAdj < 0.05 &&
					rewardDelta !== null &&
					rewardDelta < 0
				);
				const partialAdjP = partialAdjByPair.get(`${d.armA}→${d.armB}`);
				const partialDelta = partialDeltas.find(a => a.armA === d.armA && a.armB === d.armB)?.meanDelta ?? null;
				const partialHeld = !(
					partialAdjP !== undefined &&
					partialAdjP < 0.05 &&
					partialDelta !== null &&
					partialDelta < 0
				);
				const passHeld = binaryHeld && rewardHeld && partialHeld;
				const effUnderpowered = !sig && !sweepCanReachSignificance(d.pos + d.neg, metricTested.length);
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
