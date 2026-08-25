/**
 * Usage tracking, token tallying, and typeable mass calculations.
 */
import { DEFAULT_SIGIL } from "argot";
import type { ArmResult, SessionUsage } from "./types";

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

/**
 * Tally token usage and tool telemetry from a session's messages.
 */
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
		const rawUsage = message.usage;
		const usage = rawUsage && typeof rawUsage === "object" ? (rawUsage as Record<string, unknown>) : {};
		if (typeof usage.input === "number") inputTokens += usage.input;
		if (typeof usage.output === "number") outputTokens += usage.output;
		if (typeof usage.cacheRead === "number") cacheReadTokens += usage.cacheRead;
		if (typeof usage.cacheWrite === "number") cacheWriteTokens += usage.cacheWrite;
		const rawCost = usage.cost;
		if (rawCost && typeof rawCost === "object" && "total" in rawCost && typeof rawCost.total === "number") {
			costUsd += rawCost.total;
		}
		const rawContent = message.content;
		const content = Array.isArray(rawContent) ? (rawContent as Array<Record<string, unknown>>) : [];
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
