/**
 * Merging, task selection, task list provenance parsing, and trial queue ordering.
 */
import { priceTokens, type RateCard, REFERENCE_RATE_CARD, type TokenMix } from "../../cost-model";
import type { ArmResult } from "./types";

export const PINNED_TEMPERATURE = 0;

export function effectiveTemperature(config: unknown, pinned: number = PINNED_TEMPERATURE): number {
	if (config !== null && typeof config === "object" && "temperature" in config) {
		const t = config.temperature;
		if (typeof t === "number" && Number.isFinite(t) && t >= 0) return t;
	}
	return pinned;
}

export function jobNameOf(arm: string, task: string, repeat: number, repeats: number): string {
	return repeats > 1 ? `${arm}__${task}__r${repeat}` : `${arm}__${task}`;
}

export function parseJobName(jobName: string): { arm: string; task: string; repeat: number } {
	const sep = jobName.indexOf("__");
	const arm = jobName.slice(0, sep);
	let task = jobName.slice(sep + 2);
	let repeat = 0;
	const m = task.match(/__r(\d+)$/);
	if (m && m.index !== undefined) {
		repeat = Number(m[1]);
		task = task.slice(0, m.index);
	}
	return { arm, task, repeat };
}

export function selectTasks(sorted: readonly string[], limit: number | undefined): string[] {
	if (limit === undefined || limit >= sorted.length) return [...sorted];
	if (limit <= 0) return [];
	const out: string[] = [];
	for (let i = 0; i < limit; i++) {
		const idx = Math.floor((i * sorted.length) / limit);
		const task = sorted[idx];
		if (task !== undefined) {
			out.push(task);
		}
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
		if (!line.startsWith("#")) break;
		const body = line.replace(/^#+\s*/, "");
		const biased = body.match(/^@biased\b:?\s*(.*)$/i);
		if (biased) return { marked: true, biased: true, note: biased[1]?.trim() || null };
		const headline = body.match(/^@headline\b:?\s*(.*)$/i);
		if (headline) return { marked: true, biased: false, note: headline[1]?.trim() || null };
	}
	return { marked: false, biased: false, note: null };
}

export interface RunToMerge {
	readonly label: string;
	readonly model: string;
	readonly binarySha: string | null;
	readonly armFingerprints: Record<string, string> | null;
	readonly results: readonly ArmResult[];
}

export class MergeRefused extends Error {}

export function mergeRuns(runs: readonly RunToMerge[]): { results: ArmResult[]; model: string } {
	if (runs.length === 0) throw new MergeRefused("no runs to merge");

	const models = [...new Set(runs.map(r => r.model))];
	if (models.length > 1) {
		throw new MergeRefused(
			`runs use different models (${models.join(", ")}). Pooling them would average two ` +
				`providers into one number that describes neither.`,
		);
	}

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

	const shas = [...new Set(runs.map(r => r.binarySha).filter(Boolean))];
	if (shas.length > 1) {
		throw new MergeRefused(
			`runs were produced by different binaries (${shas.join(", ")}). The delta would ` +
				`include whatever else changed in the build, not just the arm.`,
		);
	}

	for (const arm of reference) {
		const fingerprints = [...new Set(runs.map(r => r.armFingerprints?.[arm]).filter(Boolean))];
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
		for (const result of run.results) {
			const cell = `${result.arm}__${result.task}`;
			const next = seen.get(cell) ?? 0;
			seen.set(cell, next + 1);
			results.push({ ...result, repeat: next });
		}
	}
	results.sort((a, b) => a.arm.localeCompare(b.arm) || a.task.localeCompare(b.task) || a.repeat - b.repeat);
	return { results, model: models[0]! };
}

export interface QueuedTrial {
	arm: string;
	task: string;
	repeat: number;
}

export function trialQueue(arms: readonly string[], tasks: readonly string[], repeats: number): QueuedTrial[] {
	const queue: QueuedTrial[] = [];
	for (const task of tasks) {
		for (let repeat = 0; repeat < repeats; repeat++) {
			for (const arm of arms) queue.push({ arm, task, repeat });
		}
	}
	return queue;
}

export interface PredictedVsActual {
	readonly predicted: number;
	readonly actual: number;
	readonly gap: number;
	readonly baselineCost: number;
	readonly treatmentCost: number;
}

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

export function onPairedTasks(results: readonly ArmResult[], armA: string, armB: string): ArmResult[] {
	const tasksOf = (arm: string) => new Set(results.filter(r => r.arm === arm && wasBilled(r)).map(r => r.task));
	const a = tasksOf(armA);
	const b = tasksOf(armB);
	const shared = new Set([...a].filter(task => b.has(task)));
	return results.filter(r => shared.has(r.task) && (r.arm === armA || r.arm === armB));
}
