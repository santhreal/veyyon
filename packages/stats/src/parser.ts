import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type AssistantMessage,
	coerceServiceTierByFamily,
	getPriorityPremiumRequests,
	resolveModelServiceTier,
	type ServiceTierByFamily,
	type ToolCall,
	type ToolResultMessage,
	type Usage,
} from "@veyyon/ai/types";
import { emptyCost } from "@veyyon/catalog/models";
import {
	clampLow,
	contentText,
	decodeJsonlLine,
	errorMessage,
	getSessionsDir,
	isEnoent,
	type JsonlByteSkip,
	logger,
	parseJsonlBytes,
	readLines,
	tryParseJson,
	visitJsonlBytes,
} from "@veyyon/utils";
import { isAdvisorTranscriptName, isSessionFileName } from "@veyyon/utils/session-file";
import type {
	AgentType,
	MessageStats,
	SessionLogEntry,
	SessionMessageEntry,
	SessionServiceTierChangeEntry,
	ToolCallStats,
	ToolResultLink,
	UserMessageLink,
	UserMessageStats,
} from "./types";
import { computeUserMessageMetrics } from "./user-metrics";

export function classifyAgentType(sessionPath: string): AgentType {
	const base = path.basename(sessionPath);
	if (isAdvisorTranscriptName(base)) {
		return "advisor";
	}
	const rel = path.relative(getSessionsDir(), sessionPath);
	return rel.split(path.sep).length <= 2 ? "main" : "subagent";
}

function extractFolderFromPath(sessionPath: string): string {
	const sessionsDir = getSessionsDir();
	const rel = path.relative(sessionsDir, sessionPath);
	const projectDir = rel.split(path.sep)[0];
	return projectDir.replace(/^--/, "/").replace(/--/g, "/");
}

function isLinkableAssistantEntry(entry: SessionLogEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	const msgEntry = entry as SessionMessageEntry;
	if (typeof msgEntry.id !== "string" || msgEntry.id.length === 0) return false;
	return msgEntry.message?.role === "assistant";
}

function isUserMessage(entry: SessionLogEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	const msgEntry = entry as SessionMessageEntry;
	if (typeof msgEntry.id !== "string" || msgEntry.id.length === 0) return false;
	return msgEntry.message?.role === "user";
}

function isServiceTierChange(entry: SessionLogEntry): entry is SessionServiceTierChangeEntry {
	return entry.type === "service_tier_change";
}

function isToolResultMessage(entry: SessionLogEntry): entry is SessionMessageEntry {
	if (entry.type !== "message") return false;
	return (entry as SessionMessageEntry).message?.role === "toolResult";
}

function entryParentId(entry: SessionLogEntry): string | null {
	const parentId = (entry as { parentId?: unknown }).parentId;
	return typeof parentId === "string" && parentId.length > 0 ? parentId : null;
}

function extractUserStats(sessionFile: string, folder: string, entry: SessionMessageEntry): UserMessageStats | null {
	const msg = entry.message as { role: "user"; content?: unknown; synthetic?: boolean };
	if (msg.role !== "user" || msg.synthetic) return null;
	const text = contentText(msg.content, "");
	if (!text.trim()) return null;
	const metrics = computeUserMessageMetrics(text);
	const ts = Date.parse(entry.timestamp);
	return {
		sessionFile,
		entryId: entry.id,
		folder,
		timestamp: Number.isFinite(ts) ? ts : 0,
		model: null,
		provider: null,
		chars: metrics.chars,
		words: metrics.words,
		yelling: metrics.yelling,
		profanity: metrics.profanity,
		anguish: metrics.anguish,
		negation: metrics.negation,
		repetition: metrics.repetition,
		blame: metrics.blame,
	};
}

function extractStats(
	sessionFile: string,
	folder: string,
	entry: SessionMessageEntry,
	currentServiceTier: ServiceTierByFamily | undefined,
	agentType: AgentType,
): MessageStats | null {
	const msg = entry.message as AssistantMessage;
	if (msg?.role !== "assistant") return null;
	if (typeof msg.model !== "string" || typeof msg.provider !== "string" || typeof msg.api !== "string") return null;
	const rawUsage = msg.usage as Partial<Usage> | undefined;
	if (!rawUsage || typeof rawUsage !== "object") return null;

	const recorded = rawUsage.premiumRequests ?? 0;
	const model = { provider: msg.provider, api: msg.api, id: msg.model };
	const tier = resolveModelServiceTier(currentServiceTier, model);
	const derived = recorded > 0 ? recorded : getPriorityPremiumRequests(tier, model);
	const wellFormed =
		typeof rawUsage.input === "number" &&
		typeof rawUsage.output === "number" &&
		typeof rawUsage.cacheRead === "number" &&
		typeof rawUsage.cacheWrite === "number" &&
		typeof rawUsage.totalTokens === "number";
	const usage: Usage =
		wellFormed && derived === recorded
			? (rawUsage as Usage)
			: {
					...rawUsage,
					input: rawUsage.input ?? 0,
					output: rawUsage.output ?? 0,
					cacheRead: rawUsage.cacheRead ?? 0,
					cacheWrite: rawUsage.cacheWrite ?? 0,
					totalTokens: rawUsage.totalTokens ?? 0,
					cost: rawUsage.cost ?? emptyCost(),
					premiumRequests: derived,
				};

	return {
		sessionFile,
		entryId: entry.id,
		folder,
		model: msg.model,
		provider: msg.provider,
		api: msg.api,
		timestamp: coerceEntryTimestamp(msg.timestamp, entry),
		duration: msg.duration ?? null,
		ttft: msg.ttft ?? null,
		stopReason: msg.stopReason ?? (msg.errorMessage ? "error" : "aborted"),
		errorMessage: msg.errorMessage ?? null,
		usage,
		agentType,
	};
}

function coerceEntryTimestamp(timestamp: number | undefined, entry: SessionMessageEntry): number {
	if (typeof timestamp === "number" && Number.isFinite(timestamp)) return timestamp;
	const ts = Date.parse(entry.timestamp);
	return Number.isFinite(ts) ? ts : 0;
}

function extractToolCalls(
	sessionFile: string,
	folder: string,
	entry: SessionMessageEntry,
	agentType: AgentType,
): ToolCallStats[] {
	const msg = entry.message as AssistantMessage;
	if (msg?.role !== "assistant" || !Array.isArray(msg.content)) return [];
	if (typeof msg.model !== "string" || typeof msg.provider !== "string") return [];

	const blocks = msg.content.filter(
		(block): block is ToolCall =>
			block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string",
	);
	if (blocks.length === 0) return [];

	return blocks.map(block => {
		let argsChars = 0;
		try {
			argsChars = JSON.stringify(block.arguments ?? {}).length;
		} catch {}
		return {
			sessionFile,
			entryId: entry.id,
			toolCallId: block.id,
			folder,
			toolName: block.name,
			model: msg.model,
			provider: msg.provider,
			timestamp: coerceEntryTimestamp(msg.timestamp, entry),
			agentType,
			callsInTurn: blocks.length,
			argsChars,
		};
	});
}

function extractToolResultLink(sessionFile: string, entry: SessionMessageEntry): ToolResultLink | null {
	const msg = entry.message as ToolResultMessage;
	if (msg.role !== "toolResult" || typeof msg.toolCallId !== "string" || msg.toolCallId.length === 0) return null;
	let resultChars = 0;
	if (Array.isArray(msg.content)) {
		for (const block of msg.content) {
			if (block.type === "text" && typeof block.text === "string") resultChars += block.text.length;
		}
	}
	return {
		sessionFile,
		toolCallId: msg.toolCallId,
		resultChars,
		isError: msg.isError === true,
	};
}

function decodeSessionEntry(text: string): SessionLogEntry | undefined {
	const parsed = tryParseJson<SessionLogEntry>(text);
	return parsed !== null && typeof parsed === "object" ? parsed : undefined;
}

type SkippedLine = JsonlByteSkip;

function visitSessionEntriesLenient(
	bytes: Uint8Array,
	visit: (entry: SessionLogEntry) => void,
	onSkip?: (skip: SkippedLine) => void,
): number {
	return visitJsonlBytes<SessionLogEntry>(bytes, visit, { decode: decodeSessionEntry, onSkip });
}

function parseSessionEntriesLenient(
	bytes: Uint8Array,
	onSkip?: (skip: SkippedLine) => void,
): { entries: SessionLogEntry[]; read: number } {
	const { items, read } = parseJsonlBytes<SessionLogEntry>(bytes, { decode: decodeSessionEntry, onSkip });
	return { entries: items, read };
}

const REPORTED_SKIPS_MAX = 20;

function reportSkippedLines(sessionPath: string, skips: SkippedLine[], start: number): void {
	if (skips.length === 0) return;
	logger.warn("Session file has unparseable lines; their messages are missing from every statistic", {
		path: sessionPath,
		skipped: skips.length,
		offsets: skips.slice(0, REPORTED_SKIPS_MAX).map(skip => start + skip.offset),
		truncatedOffsets: skips.length > REPORTED_SKIPS_MAX,
	});
}

function scanLastServiceTier(bytes: Uint8Array): ServiceTierByFamily | undefined {
	let currentServiceTier: ServiceTierByFamily | undefined;
	visitSessionEntriesLenient(bytes, entry => {
		if (isServiceTierChange(entry)) currentServiceTier = coerceServiceTierByFamily(entry.serviceTier);
	});
	return currentServiceTier;
}
export interface ParseSessionResult {
	stats: MessageStats[];
	userStats: UserMessageStats[];
	userLinks: UserMessageLink[];
	toolCalls: ToolCallStats[];
	toolResults: ToolResultLink[];
	newOffset: number;
}
export async function parseSessionFile(sessionPath: string, fromOffset = 0): Promise<ParseSessionResult> {
	let bytes: Uint8Array;
	try {
		bytes = await Bun.file(sessionPath).bytes();
	} catch (err) {
		if (isEnoent(err))
			return { stats: [], userStats: [], userLinks: [], toolCalls: [], toolResults: [], newOffset: fromOffset };
		throw err;
	}

	const folder = extractFolderFromPath(sessionPath);
	const agentType = classifyAgentType(sessionPath);
	const stats: MessageStats[] = [];
	const userStats: UserMessageStats[] = [];
	const userLinks: UserMessageLink[] = [];
	const toolCalls: ToolCallStats[] = [];
	const toolResults: ToolResultLink[] = [];
	const userByEntryId = new Map<string, UserMessageStats>();
	const start = clampLow(fromOffset, 0, bytes.length);
	const unprocessed = bytes.subarray(start);
	const skipped: SkippedLine[] = [];
	const { entries, read } = parseSessionEntriesLenient(unprocessed, skip => skipped.push(skip));
	reportSkippedLines(sessionPath, skipped, start);
	let currentServiceTier: ServiceTierByFamily | undefined;
	if (start > 0) {
		currentServiceTier = scanLastServiceTier(bytes.subarray(0, start));
	}
	for (const entry of entries) {
		if (isServiceTierChange(entry)) {
			currentServiceTier = coerceServiceTierByFamily(entry.serviceTier);
			continue;
		}
		if (isUserMessage(entry)) {
			const userMsg = extractUserStats(sessionPath, folder, entry);
			if (userMsg) {
				userStats.push(userMsg);
				userByEntryId.set(entry.id, userMsg);
			}
			continue;
		}
		if (isToolResultMessage(entry)) {
			const link = extractToolResultLink(sessionPath, entry);
			if (link) toolResults.push(link);
			continue;
		}
		if (isLinkableAssistantEntry(entry)) {
			const msgStats = extractStats(sessionPath, folder, entry, currentServiceTier, agentType);
			if (msgStats) stats.push(msgStats);
			const calls = extractToolCalls(sessionPath, folder, entry, agentType);
			for (let ci = 0; ci < calls.length; ci++) toolCalls.push(calls[ci]!);
			const parentId = (entry as SessionMessageEntry).parentId;
			if (parentId) {
				const msg = entry.message as AssistantMessage;
				if (msg.model && msg.provider) {
					userLinks.push({
						sessionFile: sessionPath,
						entryId: parentId,
						model: msg.model,
						provider: msg.provider,
					});
				}
			}
		}
	}

	return { stats, userStats, userLinks, toolCalls, toolResults, newOffset: start + read };
}

export async function listSessionFolders(): Promise<string[]> {
	const sessionsDir = getSessionsDir();
	try {
		const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
		return entries.filter(e => e.isDirectory()).map(e => path.join(sessionsDir, e.name));
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Sessions directory could not be read; every statistic below is missing all of it", {
			path: sessionsDir,
			error: errorMessage(err),
		});
		return [];
	}
}

export async function listSessionFiles(folderPath: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(folderPath, { recursive: true, withFileTypes: true });
		return entries.filter(e => e.isFile() && isSessionFileName(e.name)).map(e => path.join(e.parentPath, e.name));
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Session folder could not be read; its sessions are missing from every statistic", {
			path: folderPath,
			error: errorMessage(err),
		});
		return [];
	}
}

export async function listAllSessionFiles(): Promise<string[]> {
	const folders = await listSessionFolders();
	const allFiles: string[] = [];

	for (const folder of folders) {
		const files = await listSessionFiles(folder);
		for (let fi = 0; fi < files.length; fi++) allFiles.push(files[fi]!);
	}

	return allFiles;
}

const MAX_CONTEXT_ENTRIES = 500;

export async function getSessionEntryWithContext(
	sessionPath: string,
	entryId: string,
): Promise<{ entry: SessionMessageEntry; context: SessionLogEntry[] } | null> {
	const byId = new Map<string, SessionLogEntry>();
	try {
		for await (const line of readLines(Bun.file(sessionPath).stream())) {
			const entry = decodeJsonlLine<SessionLogEntry>(line, { decode: decodeSessionEntry });
			if (entry && "id" in entry && typeof entry.id === "string" && entry.id.length > 0) {
				byId.set(entry.id, entry);
			}
		}
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}

	const target = byId.get(entryId);
	if (target?.type !== "message") return null;
	const targetMsg = target as SessionMessageEntry;

	const chain: SessionLogEntry[] = [];
	const visited = new Set<string>();
	let cursor: SessionLogEntry | undefined = target;
	while (cursor && "id" in cursor && typeof cursor.id === "string") {
		if (visited.has(cursor.id)) break; // guard a self-referential parentId cycle
		visited.add(cursor.id);
		chain.push(cursor);
		if (isUserMessage(cursor)) break; // reached the triggering prompt for this turn
		if (chain.length >= MAX_CONTEXT_ENTRIES) break;
		const parentId = entryParentId(cursor);
		cursor = parentId ? byId.get(parentId) : undefined;
	}

	chain.reverse(); // oldest-first, requested entry last
	return { entry: targetMsg, context: chain };
}
