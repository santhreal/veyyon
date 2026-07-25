/**
 * What an arm's own config predicts it will save, derived from the run it is part of.
 *
 * WHY THIS EXISTS RATHER THAN A NUMBER IN A COMMENT. Every arm file carries a
 * predicted saving in its header, and the procedure for reading a finished run says
 * to compare that prediction against the measured cost delta. Both halves of that
 * were hand-carried: the number was typed into the arm's comment when the arm was
 * written, typed again into the post-run command, and nothing checked that either
 * copy still matched what the simulator produces. That is the same asymmetry that
 * let a tool-result threshold ship at nearly twice its real saving, one level up.
 *
 * Here the prediction is COMPUTED from two things the run already has: the arm's
 * parsed settings overlay, and the baseline arm's own transcripts from the same
 * run. Nothing is typed, so nothing can drift, and a prediction is always about the
 * workload it is being checked against rather than about whichever earlier run the
 * comment was written from.
 *
 * IT REFUSES RATHER THAN GUESSES. An arm can set a context or tool lever this
 * module has no simulator for, and quietly predicting zero for it would report a
 * confident total that silently omitted part of the treatment. Every such setting
 * is returned in `unsimulated` and the caller must print it: a partial prediction
 * that says so is useful, a partial prediction that looks complete is worse than
 * none.
 */

import {
	type PrefixMass,
	prefixStability,
	type SignatureLever,
	simulateSignatureLever,
	simulateToolResultCap,
	type TranscriptRecord,
	totalPrefixMass,
} from "./prefix-composition";

import { costShares, priceTokens, type RateCard, REFERENCE_RATE_CARD, type TokenMix } from "./cost-model";

/** One lever inside an arm, and what it is predicted to do on its own. */
export interface LeverPrediction {
	/** The settings path that turned it on, e.g. `context.thoughtSignatureMaxLength`. */
	readonly setting: string;
	readonly value: number;
	/** Share of the bill the lever stops paying for, before cache effects. */
	readonly grossSaving: number;
	/**
	 * Share of the bill handed back because the lever rewrote bytes already sent.
	 *
	 * Zero for anything keyed on an item's own size, which is most of what ships. A
	 * recency window is the exception and the reason this field is not assumed away:
	 * a deep window can surrender a quarter of its gross saving here.
	 */
	readonly cacheGiveBack: number;
	readonly netSaving: number;
	/** How much content the lever elides, as a share of the items it can act on. */
	readonly contentGivenUp: number;
	/** What `contentGivenUp` counts, so a reader is never left guessing the denominator. */
	readonly contentUnit: string;
}

export interface ArmPrediction {
	readonly arm: string;
	readonly levers: readonly LeverPrediction[];
	/**
	 * Settings the arm sets that plausibly change the prefix and have no simulator.
	 *
	 * MUST BE SURFACED WHEREVER `netSaving` IS. A non-empty list means the number
	 * below covers only part of the treatment, and an unflagged partial prediction
	 * would be read as a whole one.
	 */
	readonly unsimulated: readonly string[];
	/** Sum of the levers' net savings, as a share of the total bill. */
	readonly netSaving: number;
}

/**
 * Settings that change what goes in the prefix. Anything here without a simulator
 * below is reported as unsimulated rather than ignored.
 *
 * Kept as an explicit list rather than a prefix match on `context.`/`tools.`,
 * because most settings under those namespaces do not touch the prefix at all and
 * flagging them would train the reader to skip the warning.
 */
export const PREFIX_AFFECTING_SETTINGS: readonly string[] = [
	"context.thoughtSignatureMaxLength",
	"context.thoughtSignatureRetention",
	"context.thinkingRetention",
	"tools.artifactSpillThreshold",
	"tools.inlineOutputFloor",
];

/** Read a dotted path out of a parsed YAML overlay, or undefined if it is absent. */
function settingAt(config: unknown, dotted: string): unknown {
	let node: unknown = config;
	for (const key of dotted.split(".")) {
		if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
		node = (node as Record<string, unknown>)[key];
	}
	return node;
}

/** A finite number at `dotted`, or null when the setting is absent or not numeric. */
function numberAt(config: unknown, dotted: string): number | null {
	const value = settingAt(config, dotted);
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The share of the bill that prompt tokens account for.
 *
 * Every prediction here is a share of the PREFIX, and the prefix is only part of
 * what the run is billed for. Quoting a prefix share as a bill share is the single
 * easiest way to overstate a lever, so the conversion happens once, here, from the
 * same usage the transcripts reported.
 */
function promptShareOfBill(usage: TokenMix, rates: RateCard): number {
	const lines = costShares(priceTokens(usage, rates));
	return lines.input + lines.cacheRead + lines.cacheWrite;
}

/**
 * Predict what an arm saves, from its settings and the baseline transcripts of the
 * run it belongs to.
 *
 * `perSession` and `usage` must come from the BASELINE arm of the same run. A
 * prediction made on one workload and checked against another cannot be wrong in a
 * way anybody notices, which is exactly why it must not be possible to do by
 * accident: the caller reads both out of one `measureRunPrefix` call.
 */
export function predictArmSaving(
	arm: string,
	config: unknown,
	perSession: readonly TranscriptRecord[][],
	mass: PrefixMass,
	usage: TokenMix,
	rates: RateCard = REFERENCE_RATE_CARD,
): ArmPrediction {
	const total = totalPrefixMass(mass);
	const promptShare = promptShareOfBill(usage, rates);
	// Invalidated bytes do not stop being sent, they move from the cached rate to the
	// fresh one, so only the difference between the two rates is lost.
	const rateLoss = (rates.input - rates.cacheRead) / Math.max(rates.input, 1e-9);
	const levers: LeverPrediction[] = [];
	const simulated = new Set<string>();

	const signatureLever = (setting: string, value: number, lever: SignatureLever): LeverPrediction => {
		let removed = 0;
		let invalidated = 0;
		let touched = 0;
		let signatures = 0;
		for (const records of perSession) {
			const sim = simulateSignatureLever(records as TranscriptRecord[], lever);
			removed += sim.removed;
			touched += sim.touched;
			signatures += sim.signatures;
			invalidated += prefixStability(records as TranscriptRecord[], lever).invalidatedCharTurns;
		}
		const grossSaving = total > 0 ? (removed / total) * promptShare : 0;
		const cacheGiveBack = total > 0 ? (invalidated / total) * promptShare * rateLoss : 0;
		return {
			setting,
			value,
			grossSaving,
			cacheGiveBack,
			netSaving: grossSaving - cacheGiveBack,
			contentGivenUp: signatures > 0 ? touched / signatures : 0,
			contentUnit: "signatures",
		};
	};

	const maxLength = numberAt(config, "context.thoughtSignatureMaxLength");
	if (maxLength !== null) {
		simulated.add("context.thoughtSignatureMaxLength");
		levers.push(
			signatureLever("context.thoughtSignatureMaxLength", maxLength, {
				kind: "sizeCap",
				maxLength,
			}),
		);
	}

	const retention = numberAt(config, "context.thoughtSignatureRetention");
	if (retention !== null) {
		simulated.add("context.thoughtSignatureRetention");
		levers.push(
			signatureLever("context.thoughtSignatureRetention", retention, {
				kind: "retainLast",
				assistantMessages: retention,
			}),
		);
	}

	const spillKb = numberAt(config, "tools.artifactSpillThreshold");
	if (spillKb !== null) {
		simulated.add("tools.artifactSpillThreshold");
		let removed = 0;
		let spilled = 0;
		let results = 0;
		// The setting is in kilobytes and the census counts characters. On this
		// workload the two are interchangeable (tool output is effectively ASCII), and
		// the alternative of measuring UTF-8 bytes per result would change the answer
		// by far less than the threshold spacing.
		const cap = spillKb * 1000;
		for (const records of perSession) {
			const sim = simulateToolResultCap(records as TranscriptRecord[], cap);
			removed += sim.removed;
			spilled += sim.spilled;
			results += sim.results;
		}
		const grossSaving = total > 0 ? (removed / total) * promptShare : 0;
		levers.push({
			setting: "tools.artifactSpillThreshold",
			value: spillKb,
			grossSaving,
			// A threshold is compared against a result's own size, which never changes,
			// so the rendered prefix stays byte-identical and nothing is handed back.
			cacheGiveBack: 0,
			netSaving: grossSaving,
			contentGivenUp: results > 0 ? spilled / results : 0,
			contentUnit: "tool results",
		});
	}

	const unsimulated = PREFIX_AFFECTING_SETTINGS.filter(
		setting => !simulated.has(setting) && settingAt(config, setting) !== undefined,
	);

	return {
		arm,
		levers,
		unsimulated,
		netSaving: levers.reduce((sum, lever) => sum + lever.netSaving, 0),
	};
}

/**
 * Render a prediction for the run report.
 *
 * The unsimulated warning is printed FIRST and unconditionally when it applies,
 * because a reader who skips to the total is the reader the warning exists for.
 */
export function formatArmPrediction(prediction: ArmPrediction): string[] {
	const lines: string[] = [];
	const missing = prediction.unsimulated.join(", ");
	if (prediction.levers.length === 0) {
		// An arm whose ONLY lever is unsimulated gets a refusal, not a partial total.
		// Reporting "0.0%" here would be indistinguishable from a lever measured and
		// found worthless, which is the opposite conclusion.
		lines.push(
			prediction.unsimulated.length > 0
				? `  ${prediction.arm}: NO PREDICTION. Its only cost lever is ${missing}, which has no simulator.`
				: `  ${prediction.arm}: no simulatable cost lever set, no prediction.`,
		);
		return lines;
	}
	if (prediction.unsimulated.length > 0) {
		lines.push(
			`  ${prediction.arm}: PARTIAL PREDICTION. No simulator for ${missing}, ` +
				`so the total below covers only part of this arm.`,
		);
	}
	for (const lever of prediction.levers) {
		const cache = lever.cacheGiveBack > 0 ? ` (gross ${(100 * lever.grossSaving).toFixed(1)}%, ` +
			`${(100 * lever.cacheGiveBack).toFixed(1)}% handed back as cache misses)` : "";
		lines.push(
			`  ${prediction.arm}  ${lever.setting} = ${lever.value}` +
				`  ->  ${(100 * lever.netSaving).toFixed(1)}% of bill${cache}` +
				`, gives up ${(100 * lever.contentGivenUp).toFixed(0)}% of ${lever.contentUnit}`,
		);
	}
	if (prediction.levers.length > 1) {
		lines.push(`  ${prediction.arm}  combined  ->  ${(100 * prediction.netSaving).toFixed(1)}% of bill`);
	}
	return lines;
}
