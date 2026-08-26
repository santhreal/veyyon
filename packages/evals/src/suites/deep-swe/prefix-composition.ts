/**
 * CLI entry point for prefix composition decomposition and cost reporting.
 *
 * Coordinates multi-session measurement, prompt category decomposition, calibration,
 * cache efficiency, and lever simulations from a run's `jobs/` directory.
 */

import { cacheEfficiency, cacheHitRate, freshTokens, rebilledCostShare } from "./cache-efficiency";
import { costShares, priceTokens, REFERENCE_RATE_CARD } from "./cost-model";
import {
	CAP_SWEEP,
	SIGNATURE_CAP_SWEEP,
	simulateSignatureCap,
	simulateSignatureLever,
	simulateThinkingRetention,
} from "./lever-simulation";
import { calibratePrefix } from "./prefix-calibration";
import {
	accumulatePrefixMass,
	PREFIX_CATEGORIES,
	type PrefixCategory,
	predictedBillSaving,
	prefixShares,
	sessionPrefixSteps,
	totalPrefixMass,
} from "./prefix-mass";
import { measureRunPrefix } from "./prefix-run";
import { type PrefixLever, prefixStability } from "./prefix-stability";

if (import.meta.main) {
	const jobsRoot = process.argv[2];
	if (!jobsRoot) {
		console.error("usage: bun prefix-composition.ts <run>/jobs [arm-prefix]");
		console.error("  Decomposes what cache-read tokens are spent on, and what eliding each part would buy.");
		process.exit(2);
	}
	const armPrefix = process.argv[3] ?? "baseline__";
	const { mass, sessions, usage, caps, observations, perSession } = measureRunPrefix(jobsRoot, armPrefix);
	const total = totalPrefixMass(mass);
	const shares = prefixShares(mass);
	console.log(`arm "${armPrefix}"  sessions ${sessions}  prefix ${total.toLocaleString()} char-turns`);
	console.log("");
	for (const category of [...PREFIX_CATEGORIES].sort((a, b) => mass[b] - mass[a])) {
		const pct = (100 * shares[category]).toFixed(1).padStart(5);
		console.log(`  ${category.padEnd(14)} ${mass[category].toLocaleString().padStart(16)}  ${pct}%`);
	}
	const cost = priceTokens(usage);
	const lines = costShares(cost);
	console.log("");
	console.log(
		`priced bill $${cost.total.toFixed(2)} at reference rates  ` +
			`(prompt lines ${(100 * (lines.input + lines.cacheRead + lines.cacheWrite)).toFixed(1)}%, ` +
			`output ${(100 * lines.output).toFixed(1)}%)`,
	);
	console.log("");
	console.log("upper bound on what eliding each part would save, as a share of the bill:");
	for (const set of [["signature"], ["thinking"], ["signature", "thinking"], ["system"], ["toolResult"]] as const) {
		const saving = predictedBillSaving(mass, set as unknown as PrefixCategory[], cost);
		console.log(`  ${set.join(" + ").padEnd(24)} ${(100 * saving).toFixed(1)}%`);
	}
	const calibration = calibratePrefix(observations);
	if (calibration) {
		const unseenShare = total > 0 ? (calibration.unseenChars * observations.length) / total : 0;
		console.log("");
		console.log(
			`calibration against billed tokens: ${calibration.charsPerToken.toFixed(2)} chars/token, ` +
				`${Math.round(calibration.unseenChars).toLocaleString()} chars of prefix not in the transcript ` +
				`(${(100 * unseenShare).toFixed(1)}% of the total above)`,
		);
	}
	if (calibration) {
		const efficiency = perSession.reduce(
			(acc, records) => {
				const e = cacheEfficiency(records, calibration.charsPerToken);
				return {
					uncachedTokens: acc.uncachedTokens + e.uncachedTokens,
					cachedTokens: acc.cachedTokens + e.cachedTokens,
					cacheWriteTokens: acc.cacheWriteTokens + e.cacheWriteTokens,
					newContentTokens: acc.newContentTokens + e.newContentTokens,
					rebilledTokens: acc.rebilledTokens + e.rebilledTokens,
				};
			},
			{ uncachedTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, newContentTokens: 0, rebilledTokens: 0 },
		);
		const share = rebilledCostShare(efficiency, cost, REFERENCE_RATE_CARD);
		const fresh = freshTokens(efficiency);
		console.log("");
		console.log("prompt cache, the lever that removes nothing from the context:");
		console.log(
			`  hit rate            ${(100 * cacheHitRate(efficiency)).toFixed(1)}%  (reads only; a write is not a hit)`,
		);
		console.log(
			`  billed fresh        ${Math.round(fresh).toLocaleString()} tokens ` +
				`(${Math.round(efficiency.uncachedTokens).toLocaleString()} input + ` +
				`${Math.round(efficiency.cacheWriteTokens).toLocaleString()} write), of which ` +
				`${Math.round(efficiency.rebilledTokens).toLocaleString()} was content already sent`,
		);
		console.log(`  paying the fresh rate on re-reads costs ${(100 * share).toFixed(1)}% of the bill, for nothing`);
		const rates = perSession
			.map(records => cacheHitRate(cacheEfficiency(records, calibration.charsPerToken)))
			.filter(rate => rate > 0)
			.sort((a, b) => a - b);
		if (rates.length > 1) {
			const at = (q: number) => rates[Math.min(rates.length - 1, Math.floor(q * rates.length))] ?? 0;
			console.log(
				`  across ${rates.length} sessions   min ${(100 * (rates[0] ?? 0)).toFixed(1)}%` +
					`  p25 ${(100 * at(0.25)).toFixed(1)}%  median ${(100 * at(0.5)).toFixed(1)}%` +
					`  p75 ${(100 * at(0.75)).toFixed(1)}%  max ${(100 * (rates[rates.length - 1] ?? 0)).toFixed(1)}%`,
			);
		}
	}
	console.log("");
	console.log("what an inline-output CAP would actually reach, which is not the toolResult total:");
	const promptShare = lines.input + lines.cacheRead + lines.cacheWrite;
	for (const cap of CAP_SWEEP) {
		const point = caps.get(cap) ?? { removed: 0, spilled: 0, results: 0 };
		const ofPrefix = total > 0 ? point.removed / total : 0;
		const spillRate = point.results > 0 ? point.spilled / point.results : 0;
		console.log(
			`  cap ${cap.toLocaleString().padStart(6)} chars  ${(100 * ofPrefix).toFixed(1).padStart(5)}% of prefix` +
				`  ->  ${(100 * ofPrefix * promptShare).toFixed(1).padStart(5)}% of bill` +
				`   (spills ${(100 * spillRate).toFixed(0).padStart(3)}% of tool results)`,
		);
	}
	console.log("");
	if (perSession.length > 1) {
		console.log("");
		console.log("how much each share moves between sessions (a short run is not one number):");
		const perSessionShares = perSession
			.map(records => prefixShares(accumulatePrefixMass(sessionPrefixSteps(records))))
			.filter(shares => PREFIX_CATEGORIES.some(category => shares[category] > 0));
		for (const category of PREFIX_CATEGORIES) {
			const values = perSessionShares.map(shares => shares[category]).sort((a, b) => a - b);
			if (values.length === 0 || (values[values.length - 1] ?? 0) === 0) continue;
			const at = (q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;
			console.log(
				`  ${category.padEnd(14)} pooled ${(100 * shares[category]).toFixed(1).padStart(5)}%` +
					`   per-session min ${(100 * (values[0] ?? 0)).toFixed(1).padStart(5)}%` +
					`  median ${(100 * at(0.5)).toFixed(1).padStart(5)}%` +
					`  max ${(100 * (values[values.length - 1] ?? 0)).toFixed(1).padStart(5)}%`,
			);
		}
	}

	console.log("");
	console.log("what a SIGNATURE length cap would reach, and how much reasoning it gives up:");
	for (const cap of SIGNATURE_CAP_SWEEP) {
		const sim = perSession.reduce(
			(acc, records) => {
				const s = simulateSignatureCap(records, cap);
				return {
					removed: acc.removed + s.removed,
					touched: acc.touched + s.touched,
					signatures: acc.signatures + s.signatures,
				};
			},
			{ removed: 0, touched: 0, signatures: 0 },
		);
		const ofPrefix = total > 0 ? sim.removed / total : 0;
		const share = sim.signatures > 0 ? sim.touched / sim.signatures : 0;
		console.log(
			`  cap ${cap.toLocaleString().padStart(5)} chars  ${(100 * ofPrefix).toFixed(1).padStart(5)}% of prefix` +
				`  ->  ${(100 * ofPrefix * promptShare).toFixed(1).padStart(5)}% of bill` +
				`   (touches ${(100 * share).toFixed(0).padStart(3)}% of tool calls)`,
		);
	}

	console.log("");
	console.log("what each CONTEXT lever saves, net of the cache it invalidates:");
	const promptShareForLevers = lines.input + lines.cacheRead + lines.cacheWrite;
	const levers: { label: string; lever: PrefixLever; unit: string }[] = [
		{ label: "stock", lever: { kind: "stock" }, unit: "signatures" },
		{ label: "sig-max4000", lever: { kind: "sizeCap", maxLength: 4000 }, unit: "signatures" },
		{ label: "sig-last1", lever: { kind: "retainLast", assistantMessages: 1 }, unit: "signatures" },
		{ label: "sig-last5", lever: { kind: "retainLast", assistantMessages: 5 }, unit: "signatures" },
		{ label: "sig-last8", lever: { kind: "retainLast", assistantMessages: 8 }, unit: "signatures" },
		{ label: "think-last1", lever: { kind: "thinkingRetainLast", assistantMessages: 1 }, unit: "thinking" },
		{ label: "think-last8", lever: { kind: "thinkingRetainLast", assistantMessages: 8 }, unit: "thinking" },
	];
	for (const { label, lever, unit } of levers) {
		const totals = perSession.reduce(
			(acc, records) => {
				const s = prefixStability(records, lever);
				const sim =
					lever.kind === "thinkingRetainLast"
						? (({ removed, touched, blocks }) => ({ removed, touched, signatures: blocks }))(
								simulateThinkingRetention(records, lever.assistantMessages),
							)
						: simulateSignatureLever(records, lever);
				return {
					comparisons: acc.comparisons + s.comparisons,
					stableComparisons: acc.stableComparisons + s.stableComparisons,
					invalidatedCharTurns: acc.invalidatedCharTurns + s.invalidatedCharTurns,
					removed: acc.removed + sim.removed,
					touched: acc.touched + sim.touched,
					signatures: acc.signatures + sim.signatures,
				};
			},
			{ comparisons: 0, stableComparisons: 0, invalidatedCharTurns: 0, removed: 0, touched: 0, signatures: 0 },
		);
		const stable = totals.comparisons > 0 ? totals.stableComparisons / totals.comparisons : 1;
		const lostShare = total > 0 ? totals.invalidatedCharTurns / total : 0;
		const rateLoss =
			(REFERENCE_RATE_CARD.input - REFERENCE_RATE_CARD.cacheRead) / Math.max(REFERENCE_RATE_CARD.input, 1e-9);
		const gross = (total > 0 ? totals.removed / total : 0) * promptShareForLevers;
		const givenBack = lostShare * promptShareForLevers * rateLoss;
		const touchedShare = totals.signatures > 0 ? totals.touched / totals.signatures : 0;
		console.log(
			`  ${label.padEnd(12)} gross ${(100 * gross).toFixed(1).padStart(5)}%` +
				`  - cache ${(100 * givenBack).toFixed(1).padStart(4)}%` +
				`  = NET ${(100 * (gross - givenBack)).toFixed(1).padStart(5)}% of bill` +
				`   |  ${(100 * stable).toFixed(0).padStart(3)}% of turns keep the prefix intact` +
				`, touches ${(100 * touchedShare).toFixed(0).padStart(3)}% of ${unit}`,
		);
	}

	console.log("");
	console.log("Upper bounds. A real lever substitutes something smaller rather than nothing, and");
	console.log("none of this says the model still solves the task: only the reward gate answers that.");
}
