import type { TextContent, ToolResultMessage } from "@veyyon/ai";
import { countTokens } from "../tokenizer";
import type { AgentMessage, AgentToolCall } from "../types";
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "./entries";
import { getToolResultMessage, resolveCompactionBoundaryIndex } from "./entries";
import { estimateTokens } from "./token-estimate";
import {
	collectToolCallsById,
	isProtectedToolResult,
	isSkillReadToolResult,
	type ProtectedToolMatcher,
} from "./tool-protection";

export interface ShakeConfig {
	protectTokens: number;
	minSavings: number;
	protectedTools: ProtectedToolMatcher[];
	fenceMinTokens: number;
	keepBoundaryId?: string;
}

export const DEFAULT_SHAKE_CONFIG: ShakeConfig = {
	protectTokens: 16_000,
	minSavings: 4_000,
	protectedTools: ["skill", isSkillReadToolResult],
	fenceMinTokens: 400,
};

export const AGGRESSIVE_SHAKE_CONFIG: ShakeConfig = {
	protectTokens: 0,
	minSavings: 0,
	protectedTools: ["skill", isSkillReadToolResult],
	fenceMinTokens: 400,
};

const PLACEHOLDER_TOKEN_ESTIMATE = 16;

export interface ToolResultShakeRegion {
	kind: "toolResult";
	entry: SessionMessageEntry;
	tokens: number;
	originalText: string;
	label: string;
}

export interface BlockShakeRegion {
	kind: "block";
	entry: SessionMessageEntry | CustomMessageEntry;
	blockIndex: number;
	start: number;
	end: number;
	tokens: number;
	originalText: string;
	label: string;
}

export type ShakeRegion = ToolResultShakeRegion | BlockShakeRegion;

const OPENING_XML = /^<([a-z_-]+)(?:\s+[^>]*)?>$/;
const CLOSING_XML = /^<\/([a-z_-]+)>$/;

function toolResultText(message: ToolResultMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function entryTokens(entry: SessionEntry): number {
	if (entry.type === "message") {
		return estimateTokens(entry.message);
	}
	if (entry.type === "custom_message") {
		const content = entry.content;
		if (typeof content === "string") return content.length === 0 ? 0 : countTokens(content);
		const fragments = content.filter((block): block is TextContent => block.type === "text").map(block => block.text);
		return fragments.length === 0 ? 0 : countTokens(fragments);
	}
	return 0;
}

function scanTextForBlockRanges(text: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	let inFence = false;
	let fenceStart = -1;
	const tagStack: string[] = [];
	let xmlStart = -1;

	let lineStart = 0;
	for (let i = 0; i <= text.length; i++) {
		if (i !== text.length && text[i] !== "\n") continue;
		const line = text.slice(lineStart, i);
		const lineEnd = i; // offset of the newline (or end of text); excludes the "\n"
		const trimmedStart = line.trimStart();

		const isFenceLine = trimmedStart.startsWith("```") || trimmedStart.startsWith("~~~");
		if (isFenceLine) {
			if (!inFence) {
				inFence = true;
				fenceStart = lineStart;
			} else {
				inFence = false;
				ranges.push({ start: fenceStart, end: lineEnd });
				fenceStart = -1;
			}
			lineStart = i + 1;
			continue;
		}

		if (!inFence) {
			const isOpeningXml = line.length === trimmedStart.length && OPENING_XML.test(trimmedStart);
			if (isOpeningXml) {
				const match = OPENING_XML.exec(trimmedStart);
				if (match) {
					if (tagStack.length === 0) xmlStart = lineStart;
					tagStack.push(match[1]);
				}
			} else {
				const closingMatch = CLOSING_XML.exec(trimmedStart);
				if (closingMatch && tagStack.length > 0 && tagStack[tagStack.length - 1] === closingMatch[1]) {
					tagStack.pop();
					if (tagStack.length === 0 && xmlStart >= 0) {
						ranges.push({ start: xmlStart, end: lineEnd });
						xmlStart = -1;
					}
				}
			}
		}

		lineStart = i + 1;
	}

	return mergeRanges(ranges);
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
	if (ranges.length <= 1) return ranges;
	const sorted = ranges.slice().sort((a, b) => a.start - b.start);
	const kept: Array<{ start: number; end: number }> = [];
	let lastEnd = -1;
	for (const range of sorted) {
		if (range.start < lastEnd) continue;
		kept.push(range);
		lastEnd = range.end;
	}
	return kept;
}

function pushBlockRegions(
	entry: SessionMessageEntry | CustomMessageEntry,
	blockIndex: number,
	text: string,
	config: ShakeConfig,
	label: string,
	out: ShakeRegion[],
): void {
	for (const range of scanTextForBlockRanges(text)) {
		const slice = text.slice(range.start, range.end);
		if (slice.length === 0) continue;
		const tokens = countTokens(slice);
		if (tokens < config.fenceMinTokens) continue;
		out.push({
			kind: "block",
			entry,
			blockIndex,
			start: range.start,
			end: range.end,
			tokens,
			originalText: slice,
			label,
		});
	}
}

function collectBlockRegions(
	entry: SessionMessageEntry | CustomMessageEntry,
	config: ShakeConfig,
	out: ShakeRegion[],
): void {
	if (entry.type === "message") {
		const message = entry.message;
		if (message.role === "assistant") {
			for (let bi = 0; bi < message.content.length; bi++) {
				const block = message.content[bi];
				if (block.type === "text") pushBlockRegions(entry, bi, block.text, config, "assistant", out);
			}
			return;
		}
		if (message.role === "user" || message.role === "developer") {
			scanContentBlocks(entry, message.content, config, message.role, out);
		}
		return;
	}
	scanContentBlocks(entry, entry.content, config, entry.customType, out);
}

function scanContentBlocks(
	entry: SessionMessageEntry | CustomMessageEntry,
	content: string | Array<{ type: string; text?: string }>,
	config: ShakeConfig,
	label: string,
	out: ShakeRegion[],
): void {
	if (typeof content === "string") {
		pushBlockRegions(entry, -1, content, config, label, out);
		return;
	}
	for (let bi = 0; bi < content.length; bi++) {
		const block = content[bi];
		if (block.type === "text" && typeof block.text === "string") {
			pushBlockRegions(entry, bi, block.text, config, label, out);
		}
	}
}

export function collectShakeRegions(entries: SessionEntry[], config: ShakeConfig): ShakeRegion[] {
	const n = entries.length;
	if (n === 0) return [];

	const accumulatedAfter = new Array<number>(n);
	let acc = 0;
	for (let i = n - 1; i >= 0; i--) {
		accumulatedAfter[i] = acc;
		acc += entryTokens(entries[i]);
	}

	const toolCallsById = collectToolCallsById(entries);

	const boundaryIndex = resolveCompactionBoundaryIndex(entries, config.keepBoundaryId);

	const regions: ShakeRegion[] = [];
	for (let i = 0; i < n; i++) {
		const entry = entries[i];
		if (i < boundaryIndex) continue;
		const toolResult = getToolResultMessage(entry);
		const uselessResult = toolResult !== undefined && toolResult.useless === true && toolResult.isError !== true;
		if (!uselessResult && accumulatedAfter[i] < config.protectTokens) continue;
		if (toolResult) {
			if (toolResult.prunedAt !== undefined) continue;
			if (isProtectedToolResult(toolResult, toolCallsById.get(toolResult.toolCallId), config.protectedTools))
				continue;
			const text = toolResultText(toolResult);
			if (text.length === 0) continue;
			regions.push({
				kind: "toolResult",
				entry: entry as SessionMessageEntry,
				tokens: estimateTokens(toolResult as AgentMessage),
				originalText: text,
				label: toolResult.toolName,
			});
			continue;
		}

		if (entry.type === "message" || entry.type === "custom_message") {
			collectBlockRegions(entry as SessionMessageEntry | CustomMessageEntry, config, regions);
		}
	}

	let savings = 0;
	for (const region of regions) savings += Math.max(0, region.tokens - PLACEHOLDER_TOKEN_ESTIMATE);
	if (savings < config.minSavings) return [];

	return regions;
}

function redundancySignature(toolName: string, call: AgentToolCall | undefined, outputText: string): string {
	const args = call?.arguments;
	const argsKey = args === undefined ? "" : JSON.stringify(args, Object.keys(args).sort());
	return `${toolName}\x00${argsKey}\x00${outputText}`;
}

export function collectRedundantToolResultRegions(entries: SessionEntry[], config: ShakeConfig): ShakeRegion[] {
	const n = entries.length;
	if (n === 0) return [];

	const toolCallsById = collectToolCallsById(entries);

	const boundaryIndex = resolveCompactionBoundaryIndex(entries, config.keepBoundaryId);

	interface Candidate {
		index: number;
		entry: SessionMessageEntry;
		message: ToolResultMessage;
		signature: string;
		text: string;
	}
	const candidates: Candidate[] = [];
	const latestBySignature = new Map<string, number>();

	for (let i = boundaryIndex; i < n; i++) {
		const toolResult = getToolResultMessage(entries[i]);
		if (!toolResult) continue;
		if (toolResult.prunedAt !== undefined) continue;
		if (toolResult.isError === true) continue;
		if (isProtectedToolResult(toolResult, toolCallsById.get(toolResult.toolCallId), config.protectedTools)) continue;
		const text = toolResultText(toolResult);
		if (text.length === 0) continue;
		const signature = redundancySignature(toolResult.toolName, toolCallsById.get(toolResult.toolCallId), text);
		candidates.push({ index: i, entry: entries[i] as SessionMessageEntry, message: toolResult, signature, text });
		latestBySignature.set(signature, i);
	}

	const regions: ShakeRegion[] = [];
	for (const candidate of candidates) {
		if (latestBySignature.get(candidate.signature) === candidate.index) continue;
		regions.push({
			kind: "toolResult",
			entry: candidate.entry,
			tokens: estimateTokens(candidate.message as AgentMessage),
			originalText: candidate.text,
			label: candidate.message.toolName,
		});
	}
	return regions;
}

interface TextSlot {
	read(): string;
	write(value: string): void;
}

function getBlockTextSlot(entry: SessionMessageEntry | CustomMessageEntry, blockIndex: number): TextSlot | undefined {
	if (entry.type === "message") {
		const message = entry.message as { content: unknown };
		if (blockIndex === -1) {
			if (typeof message.content !== "string") return undefined;
			return {
				read: () => message.content as string,
				write: value => {
					message.content = value;
				},
			};
		}
		if (!Array.isArray(message.content)) return undefined;
		const block = message.content[blockIndex] as TextContent | undefined;
		if (block?.type !== "text") return undefined;
		return {
			read: () => block.text,
			write: value => {
				block.text = value;
			},
		};
	}
	if (blockIndex === -1) {
		if (typeof entry.content !== "string") return undefined;
		return {
			read: () => entry.content as string,
			write: value => {
				entry.content = value;
			},
		};
	}
	if (!Array.isArray(entry.content)) return undefined;
	const block = entry.content[blockIndex] as TextContent | undefined;
	if (block?.type !== "text") return undefined;
	return {
		read: () => block.text,
		write: value => {
			block.text = value;
		},
	};
}

export function applyShakeRegion(region: ShakeRegion, replacement: string): void {
	if (region.kind === "toolResult") {
		const message = region.entry.message as ToolResultMessage;
		message.content = [{ type: "text", text: replacement }];
		message.prunedAt = Date.now();
		return;
	}
	const slot = getBlockTextSlot(region.entry, region.blockIndex);
	if (!slot) return;
	const text = slot.read();
	slot.write(text.slice(0, region.start) + replacement + text.slice(region.end));
}

export function applyShakeRegions(items: Array<{ region: ShakeRegion; replacement: string }>): void {
	const ordered = items.slice().sort((a, b) => {
		const aStart = a.region.kind === "block" ? a.region.start : -1;
		const bStart = b.region.kind === "block" ? b.region.start : -1;
		return bStart - aStart;
	});
	for (const { region, replacement } of ordered) applyShakeRegion(region, replacement);
}
