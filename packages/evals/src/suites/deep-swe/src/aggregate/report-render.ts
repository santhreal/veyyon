/**
 * Markdown report rendering, cost tables, cache invalidation, and timeout attribution.
 */
import { costShares, priceTokens, REFERENCE_RATE_CARD } from "../shared";
import { interpretEncodeArm } from "./encode-probe";
import { classifyError, providerQuotaStop } from "./error-classification";
import type { TaskSetProvenance } from "./merge";
import {
	ceilingBelowNoise,
	holmBonferroni,
	mean,
	pairwiseArmDeltas,
	pairwiseMetricDeltas,
	summarizeCell,
	sweepCanReachSignificance,
	withinTaskSpreadPct,
} from "./stats";
import type { ArmResult, CellSummary } from "./types";

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
				`their cache tokens cannot be priced (a read costs ${REFERENCE_RATE_CARD.cacheRead}/M, a write ` +
				`${REFERENCE_RATE_CARD.cacheWrite}/M, and the older records carry only the sum). Re-run to get a ` +
				"priced comparison.",
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
		const notes: string[] = [];
		if (s.errors > 0) notes.push(`+${s.errors} err`);
		if (s.timedOut > 0) notes.push(`${s.timedOut} timed out`);
		const samples = notes.length > 0 ? `${s.n} (${notes.join(", ")})` : String(s.n);
		lines.push(
			`| ${arm} | ${samples} | ${withDelta(c.input, b?.input ?? 0)} | ${withDelta(c.cacheRead, b?.cacheRead ?? 0)} | ` +
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

function fmt(n: number | null, digits = 0): string {
	if (n === null || n === undefined) return "—";
	return digits > 0 ? n.toFixed(digits) : String(Math.round(n));
}

function fmtRate(s: CellSummary): string {
	if (s.passRate === null) return "—";
	const ci =
		s.wilsonLow === null || s.wilsonHigh === null ? "" : ` [${s.wilsonLow.toFixed(2)}–${s.wilsonHigh.toFixed(2)}]`;
	return `${s.passRate.toFixed(2)}${ci} (${s.passes}/${s.n})`;
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
				of: c => {
					const gradedOkCount = c.n - c.timedOut;
					return c.refCostMeasurable && gradedOkCount > 0 ? c.refCost.total / gradedOkCount : null;
				},
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
				const cheaperB = d.neg;
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
			const handleVals = rows
				.map(r => r.argotHandlesLoaded)
				.filter((h): h is number => h !== null && h !== undefined);
			const handlesLoaded = handleVals.length === 0 ? null : Math.max(...handleVals);
			const handlesCell = handlesLoaded === null ? "—" : `${handlesLoaded}`;
			const tableTaught = rows.filter(r => r.argotHandlesTaught === true).length;
			const tableKnown = rows.filter(r => r.argotHandlesTaught !== null).length;
			const tableCell = tableKnown === 0 ? "—" : `${tableTaught}/${tableKnown}`;
			lines.push(
				`| ${a} | ${rows.length} | ${taughtCell} | ${handlesCell} | ${tableCell} | ${fmt(mean(rows.map(r => r.argotLoadCalls ?? null)), 2)} | ` +
					`${fmt(mean(rows.map(r => r.assistantMsgsWithSigil ?? null)), 2)} | ${encoded}/${rows.length} |`,
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
	const headroomArms = arms.filter(a =>
		okByArm(a).some(r => r.encodeHeadroom !== null && r.encodeHeadroom !== undefined),
	);
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
			const rows = okByArm(a).filter(r => r.encodeHeadroom !== null && r.encodeHeadroom !== undefined);
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
				`| ${r.arm} | ${r.task} | ${r.repeat} | ${fmt(r.argotLoadCalls ?? null)} | ${fmt(r.assistantMsgsWithSigil ?? null)} |`,
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
