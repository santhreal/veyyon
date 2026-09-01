import { costShares, priceTokens, type RateCard, REFERENCE_RATE_CARD, type TokenMix } from "./cost-model";
import {
	type PrefixMass,
	prefixStability,
	type SignatureLever,
	simulateSignatureLever,
	simulateThinkingRetention,
	simulateToolResultCap,
	type TranscriptRecord,
	totalPrefixMass,
} from "./prefix-composition";

export interface LeverPrediction {
	readonly setting: string;
	readonly value: number;
	readonly grossSaving: number;
	readonly cacheGiveBack: number;
	readonly netSaving: number;
	readonly contentGivenUp: number;
	readonly contentUnit: string;
}

export interface ArmPrediction {
	readonly arm: string;
	readonly levers: readonly LeverPrediction[];
	readonly unsimulated: readonly string[];
	readonly netSaving: number;
}

export const PREFIX_AFFECTING_SETTINGS: readonly string[] = [
	"context.thoughtSignatureMaxLength",
	"context.thoughtSignatureRetention",
	"context.thinkingRetention",
	"tools.artifactSpillThreshold",
	"tools.inlineOutputFloor",
];

function settingAt(config: unknown, dotted: string): unknown {
	let node: unknown = config;
	for (const key of dotted.split(".")) {
		if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
		node = (node as Record<string, unknown>)[key];
	}
	return node;
}

function numberAt(config: unknown, dotted: string): number | null {
	const value = settingAt(config, dotted);
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function promptShareOfBill(usage: TokenMix, rates: RateCard): number {
	const lines = costShares(priceTokens(usage, rates));
	return lines.input + lines.cacheRead + lines.cacheWrite;
}

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

	const thinking = numberAt(config, "context.thinkingRetention");
	if (thinking !== null) {
		simulated.add("context.thinkingRetention");
		let removed = 0;
		let invalidated = 0;
		let touched = 0;
		let blocks = 0;
		const lever = { kind: "thinkingRetainLast", assistantMessages: thinking } as const;
		for (const records of perSession) {
			const sim = simulateThinkingRetention(records as TranscriptRecord[], thinking);
			removed += sim.removed;
			touched += sim.touched;
			blocks += sim.blocks;
			invalidated += prefixStability(records as TranscriptRecord[], lever).invalidatedCharTurns;
		}
		const grossSaving = total > 0 ? (removed / total) * promptShare : 0;
		const cacheGiveBack = total > 0 ? (invalidated / total) * promptShare * rateLoss : 0;
		levers.push({
			setting: "context.thinkingRetention",
			value: thinking,
			grossSaving,
			cacheGiveBack,
			netSaving: grossSaving - cacheGiveBack,
			contentGivenUp: blocks > 0 ? touched / blocks : 0,
			contentUnit: "thinking blocks",
		});
	}

	const spillKb = numberAt(config, "tools.artifactSpillThreshold");
	if (spillKb !== null) {
		simulated.add("tools.artifactSpillThreshold");
		let removed = 0;
		let spilled = 0;
		let results = 0;
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

export function formatArmPrediction(prediction: ArmPrediction): string[] {
	const lines: string[] = [];
	const missing = prediction.unsimulated.join(", ");
	if (prediction.levers.length === 0) {
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
		const cache =
			lever.cacheGiveBack > 0
				? ` (gross ${(100 * lever.grossSaving).toFixed(1)}%, ` +
					`${(100 * lever.cacheGiveBack).toFixed(1)}% handed back as cache misses)`
				: "";
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
