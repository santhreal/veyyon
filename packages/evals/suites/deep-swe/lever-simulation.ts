/**
 * Prefix lever simulations: inline tool result caps, thought signature caps and recency windows,
 * and thinking retention windows.
 *
 * Simulates the character-turns removed from the prefix and tool calls or signatures
 * touched by each lever configuration.
 */

import { firstRetainedAssistantIndex } from "@veyyon/ai/providers/google-shared";
import { artifactFooter, formatMiddleElisionMarker } from "@veyyon/coding-agent/session/streaming-output";

import type { TranscriptRecord } from "./prefix-mass";
import { type SignatureLever, type SignatureSite, SKIP_SIGNATURE_CHARS, sentLength } from "./prefix-stability";

/**
 * Tools exempt from inline tool result spills (e.g. `read` has line-bound contracts).
 */
export const SPILL_EXEMPT_TOOLS: readonly string[] = ["read"];

/**
 * Characters a spilled tool result costs instead of the bytes it replaces.
 * (Artifact footer and middle elision marker overhead).
 */
export const SPILL_SUBSTITUTION_CHARS = artifactFooter("12").length + formatMiddleElisionMarker(120, 4000).length + 2;

/**
 * Characters a spill saves on one result, or zero if it would not spill.
 */
function spillSaving(chars: number, cap: number): number {
	if (chars <= cap) return 0;
	return Math.max(0, chars - cap - SPILL_SUBSTITUTION_CHARS);
}

/** Map every tool call's id to its name for attribution. */
function toolNamesById(records: Iterable<TranscriptRecord>): Map<string, string> {
	const names = new Map<string, string>();
	for (const record of records) {
		if (record.type !== "message" || record.message?.role !== "assistant") continue;
		for (const block of record.message.content ?? []) {
			if (block.type !== "toolCall") continue;
			const id = block.toolCallId ?? block.id;
			if (typeof id === "string" && typeof block.name === "string") names.set(id, block.name);
		}
	}
	return names;
}

/**
 * The inline-output caps the sweep reports, from shipped default down to 1000.
 */
export const CAP_SWEEP = [50_000, 20_000, 10_000, 5000, 2000, 1000] as const;

/** One threshold's entry in the inline-output sweep. */
export interface CapSweepPoint {
	/** Character-turns removed, net of the marker and footer that replace them. */
	removed: number;
	/** Results that would spill at this threshold, counted once each. */
	spilled: number;
	/** Non-empty tool results in the transcripts, spilled or not. */
	results: number;
}

/**
 * What capping every inline tool result at `cap` characters would remove from the
 * prefix, in character-turns.
 */
export function simulateToolResultCap(
	records: TranscriptRecord[],
	cap: number,
	exempt: readonly string[] = SPILL_EXEMPT_TOOLS,
): { removed: number; total: number; spilled: number; results: number } {
	const names = toolNamesById(records);
	const exemptSet = new Set(exempt);
	let removed = 0;
	let total = 0;
	let running = 0;
	let spilled = 0;
	let resultCount = 0;
	const results: { chars: number; cappable: boolean }[] = [];
	for (const record of records) {
		if (record.type === "session_init") {
			running += (record.systemPrompt ?? "").length + JSON.stringify(record.tools ?? []).length;
			continue;
		}
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		const content = message.content ?? [];
		if (message.role === "assistant") {
			if (message.usage) {
				total += running + results.reduce((sum, r) => sum + r.chars, 0);
				removed += results.reduce((sum, r) => sum + (r.cappable ? spillSaving(r.chars, cap) : 0), 0);
			}
			for (const block of content) {
				if (block.type === "toolCall") {
					running += JSON.stringify(block.arguments ?? {}).length;
					running += (block.thoughtSignature ?? "").length;
				} else if (block.type === "thinking") {
					running += (block.thinking ?? "").length;
				} else if (block.type === "text") {
					running += (block.text ?? "").length;
				}
			}
			continue;
		}
		if (message.role === "toolResult") {
			const chars = content.reduce((sum, block) => sum + (block.text ?? "").length, 0);
			if (chars > 0) {
				const id = message.toolCallId ?? message.id;
				const name = (typeof id === "string" ? names.get(id) : undefined) ?? message.toolName;
				const cappable = !exemptSet.has(name ?? "");
				results.push({ chars, cappable });
				resultCount += 1;
				if (cappable && spillSaving(chars, cap) > 0) spilled += 1;
			}
			continue;
		}
		if (message.role === "user") {
			running += content.reduce((sum, b) => sum + (b.type === "text" ? (b.text ?? "").length : 0), 0);
		}
	}
	return { removed, total, spilled, results: resultCount };
}

/**
 * The signature length caps the sweep reports, matching `arms/sig-max4000.yml`.
 */
export const SIGNATURE_CAP_SWEEP = [8000, 4000, 2000, 1000] as const;

/** What a signature lever removes from the prefix, and what it gives up to get it. */
export interface SignatureSimulation {
	/** Character-turns the lever stops sending, already net of the sentinel. */
	readonly removed: number;
	/** Character-turns the prefix costs without the lever, for the same walk. */
	readonly total: number;
	/** Signatures elided on at least one billed turn. */
	readonly touched: number;
	/** Signatures present in the session, elided or not. */
	readonly signatures: number;
}

/**
 * What capping every thought signature at `cap` characters would remove from the
 * prefix, in character-turns, and how many tool calls it would touch.
 */
export function simulateSignatureCap(records: TranscriptRecord[], cap: number): SignatureSimulation {
	return simulateSignatureLever(records, { kind: "sizeCap", maxLength: cap });
}

/**
 * What any signature lever would remove from the prefix, in character-turns.
 */
export function simulateSignatureLever(records: TranscriptRecord[], lever: SignatureLever): SignatureSimulation {
	let removed = 0;
	let total = 0;
	let running = 0;
	let signatures = 0;
	let assistantMessages = 0;
	const sites: SignatureSite[] = [];
	const everElided = new Set<number>();
	for (const record of records) {
		if (record.type === "session_init") {
			running += (record.systemPrompt ?? "").length + JSON.stringify(record.tools ?? []).length;
			continue;
		}
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		const content = message.content ?? [];
		if (message.role === "assistant") {
			if (message.usage) {
				total += running;
				for (let index = 0; index < sites.length; index++) {
					const site = sites[index];
					if (!site) continue;
					total += site.length;
					const sent = sentLength(lever, site, assistantMessages);
					removed += site.length - sent;
					if (sent < site.length) everElided.add(index);
				}
			}
			for (const block of content) {
				if (block.type === "toolCall") {
					const length = (block.thoughtSignature ?? "").length;
					if (length > 0) {
						sites.push({ assistantIndex: assistantMessages, length, sentinel: SKIP_SIGNATURE_CHARS });
						signatures += 1;
					}
					running += JSON.stringify(block.arguments ?? {}).length;
				} else if (block.type === "thinking") {
					running += (block.thinking ?? "").length;
				} else if (block.type === "text") {
					running += (block.text ?? "").length;
				}
			}
			assistantMessages += 1;
			continue;
		}
		if (message.role === "toolResult") {
			running += content.reduce((sum, block) => sum + (block.text ?? "").length, 0);
			continue;
		}
		if (message.role === "user") {
			running += content.reduce((sum, b) => sum + (b.type === "text" ? (b.text ?? "").length : 0), 0);
		}
	}
	return { removed, total, touched: everElided.size, signatures };
}

/**
 * What a thinking retention window would remove from the prefix, in character-turns.
 */
export function simulateThinkingRetention(
	records: TranscriptRecord[],
	retention: number,
): { removed: number; total: number; touched: number; blocks: number } {
	let removed = 0;
	let total = 0;
	let running = 0;
	const roles: { role: string }[] = [];
	const sites: { messageIndex: number; chars: number }[] = [];
	const everElided = new Set<number>();
	for (const record of records) {
		if (record.type === "session_init") {
			running += (record.systemPrompt ?? "").length + JSON.stringify(record.tools ?? []).length;
			continue;
		}
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		const content = message.content ?? [];
		if (message.role === "assistant") {
			if (message.usage) {
				total += running;
				const boundary = firstRetainedAssistantIndex(roles as never, retention);
				for (let index = 0; index < sites.length; index++) {
					const site = sites[index];
					if (!site) continue;
					total += site.chars;
					if (site.messageIndex < boundary) {
						removed += site.chars;
						everElided.add(index);
					}
				}
			}
			const messageIndex = roles.length;
			for (const block of content) {
				if (block.type === "toolCall") {
					running += JSON.stringify(block.arguments ?? {}).length;
					running += (block.thoughtSignature ?? "").length;
				} else if (block.type === "thinking") {
					const chars = (block.thinking ?? "").length;
					if (chars > 0) sites.push({ messageIndex, chars });
				} else if (block.type === "text") {
					running += (block.text ?? "").length;
				}
			}
			roles.push({ role: "assistant" });
			continue;
		}
		if (message.role === "toolResult") {
			running += content.reduce((sum, block) => sum + (block.text ?? "").length, 0);
			roles.push({ role: "toolResult" });
			continue;
		}
		if (message.role === "user") {
			running += content.reduce((sum, b) => sum + (b.type === "text" ? (b.text ?? "").length : 0), 0);
			roles.push({ role: "user" });
		}
	}
	return { removed, total, touched: everElided.size, blocks: sites.length };
}
