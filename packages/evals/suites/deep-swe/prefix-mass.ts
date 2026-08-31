/**
 * Prefix mass measurement, turn weighting, and prompt category decomposition.
 *
 * This module measures the composition of a prompt prefix by category and weights
 * each category by how many billed turns it sits in the prefix, matching provider
 * billing mechanics.
 */

import { type CostBreakdown, costShares } from "./cost-model";

/**
 * The categories a prompt prefix decomposes into.
 *
 * These match the levers that act on them. `signature` is separate from `thinking`
 * because they are elided by different settings. `system` is separate because it is
 * the fixed block that tool discovery can alter.
 */
export type PrefixCategory =
	| "signature"
	| "toolResult"
	| "system"
	| "thinking"
	| "arguments"
	| "assistantText"
	| "userText";

/** Every category, in a fixed order, so reports and tests never depend on key iteration. */
export const PREFIX_CATEGORIES: readonly PrefixCategory[] = [
	"signature",
	"toolResult",
	"system",
	"thinking",
	"arguments",
	"assistantText",
	"userText",
] as const;

/**
 * Turn-weighted prefix mass, in character-turns.
 *
 * One character sitting in the prefix for one billed turn is one character-turn.
 * A category's value is the integral of its size over the turns it was present for.
 */
export type PrefixMass = Record<PrefixCategory, number>;

/** A zeroed accumulator so callers can fold sessions into one total. */
export function emptyPrefixMass(): PrefixMass {
	return {
		signature: 0,
		toolResult: 0,
		system: 0,
		thinking: 0,
		arguments: 0,
		assistantText: 0,
		userText: 0,
	};
}

/** The size, in characters, that each category grew by at one point in a session. */
export type PrefixDelta = Partial<Record<PrefixCategory, number>>;

/**
 * One step in replaying a session: either the prefix grew, or a turn was billed
 * against the prefix as it stood.
 */
export type PrefixStep = { kind: "grow"; delta: PrefixDelta } | { kind: "billedTurn" };

/**
 * Replay a session's steps and accumulate turn-weighted prefix mass.
 *
 * At every billed turn, the whole running prefix is charged once. Growth applied
 * after a turn is not charged for that turn.
 */
export function accumulatePrefixMass(steps: Iterable<PrefixStep>, into: PrefixMass = emptyPrefixMass()): PrefixMass {
	const running = emptyPrefixMass();
	for (const step of steps) {
		if (step.kind === "billedTurn") {
			for (const category of PREFIX_CATEGORIES) into[category] += running[category];
			continue;
		}
		for (const category of PREFIX_CATEGORIES) running[category] += step.delta[category] ?? 0;
	}
	return into;
}

/** The sum of every category. Zero for an empty accumulator, never NaN. */
export function totalPrefixMass(mass: PrefixMass): number {
	return PREFIX_CATEGORIES.reduce((sum, category) => sum + mass[category], 0);
}

/**
 * Each category's share of the prefix, as a fraction in [0, 1].
 *
 * A zero total yields all-zero shares rather than NaN.
 */
export function prefixShares(mass: PrefixMass): Record<PrefixCategory, number> {
	const total = totalPrefixMass(mass);
	const shares = emptyPrefixMass();
	if (total <= 0) return shares;
	for (const category of PREFIX_CATEGORIES) shares[category] = mass[category] / total;
	return shares;
}

/**
 * The fraction of the bill that removing a set of prefix categories would buy, at
 * a measured cost breakdown.
 *
 * Scales the prefix share by the prompt lines' share of the total bill.
 */
export function predictedBillSaving(mass: PrefixMass, elided: readonly PrefixCategory[], cost: CostBreakdown): number {
	const shares = prefixShares(mass);
	const prefixFraction = elided.reduce((sum, category) => sum + shares[category], 0);
	const lines = costShares(cost);
	const promptShare = lines.input + lines.cacheRead + lines.cacheWrite;
	return prefixFraction * promptShare;
}

/**
 * A parsed line of a veyyon session transcript.
 */
export interface TranscriptRecord {
	type?: string;
	systemPrompt?: string;
	tools?: unknown;
	message?: {
		role?: string;
		usage?: unknown;
		toolCallId?: string;
		id?: string;
		toolName?: string;
		content?: Array<{
			type?: string;
			text?: string;
			thinking?: string;
			thoughtSignature?: string;
			arguments?: unknown;
			name?: string;
			toolCallId?: string;
			id?: string;
		}>;
	};
}

/**
 * Turn a parsed session transcript into the steps {@link accumulatePrefixMass} replays.
 *
 * An assistant message with `usage` emits `billedTurn` first and appends its own content
 * afterwards, preventing charging a turn for its own generation.
 */
export function sessionPrefixSteps(records: Iterable<TranscriptRecord>): PrefixStep[] {
	const steps: PrefixStep[] = [];
	for (const record of records) {
		if (record.type === "session_init") {
			const system = (record.systemPrompt ?? "").length + JSON.stringify(record.tools ?? []).length;
			if (system > 0) steps.push({ kind: "grow", delta: { system } });
			continue;
		}
		if (record.type !== "message") continue;
		const message = record.message;
		if (!message) continue;
		const content = message.content ?? [];
		if (message.role === "assistant") {
			if (message.usage) steps.push({ kind: "billedTurn" });
			const delta: PrefixDelta = {};
			for (const block of content) {
				if (block.type === "toolCall") {
					delta.signature = (delta.signature ?? 0) + (block.thoughtSignature ?? "").length;
					delta.arguments = (delta.arguments ?? 0) + JSON.stringify(block.arguments ?? {}).length;
				} else if (block.type === "thinking") {
					delta.thinking = (delta.thinking ?? 0) + (block.thinking ?? "").length;
				} else if (block.type === "text") {
					delta.assistantText = (delta.assistantText ?? 0) + (block.text ?? "").length;
				}
			}
			steps.push({ kind: "grow", delta });
			continue;
		}
		if (message.role === "toolResult") {
			const toolResult = content.reduce((sum, block) => sum + (block.text ?? "").length, 0);
			steps.push({ kind: "grow", delta: { toolResult } });
			continue;
		}
		if (message.role === "user") {
			const userText = content.reduce(
				(sum, block) => sum + (block.type === "text" ? (block.text ?? "").length : 0),
				0,
			);
			steps.push({ kind: "grow", delta: { userText } });
		}
	}
	return steps;
}
