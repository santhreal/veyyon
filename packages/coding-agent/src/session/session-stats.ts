/**
 * Session usage accounting: whole-session token/cost stats (`/session`) and
 * the anchored context-window breakdown (status line, compaction headroom).
 * Free functions over the session's public surface; the in-flight pending
 * context snapshot is passed in by the session, which owns it.
 */
import type { AgentMessage } from "@veyyon/pi-agent-core";
import { calculatePromptTokens, estimateTokens, type SessionMessageEntry } from "@veyyon/pi-agent-core/compaction";
import type { AssistantMessage, Usage } from "@veyyon/pi-ai";
import type { ContextUsage } from "../extensibility/extensions/types";
import { computeNonMessageBreakdown, computeNonMessageTokens } from "../modes/utils/context-usage";
import type { AgentSession } from "./agent-session";
import { getLatestCompactionEntry } from "./session-context";

export interface ContextUsageBreakdown {
	contextWindow: number;
	anchored: boolean;
	usedTokens: number;
	systemPromptTokens: number;
	systemToolsTokens: number;
	systemContextTokens: number;
	skillsTokens: number;
	messagesTokens: number;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		reasoning: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	premiumRequests: number;
	cost: number;
	contextUsage?: ContextUsage;
}

/** Turn-start estimate of the prompt the provider has not yet reported usage for. */
export interface PendingContextSnapshot {
	promptTokens: number;
	nonMessageTokens: number;
	cutoffCount: number;
}

export function computeSessionStats(session: AgentSession): SessionStats {
	const state = session.state;
	const userMessages = state.messages.filter(m => m.role === "user").length;
	const assistantMessages = state.messages.filter(m => m.role === "assistant").length;
	const toolResults = state.messages.filter(m => m.role === "toolResult").length;

	let toolCalls = 0;
	let totalInput = 0;
	let totalOutput = 0;
	let totalCacheRead = 0;
	let totalReasoning = 0;
	let totalCacheWrite = 0;
	let totalTokens = 0;
	let totalCost = 0;
	let totalPremiumRequests = 0;

	const getTaskToolUsage = (details: unknown): Usage | undefined => {
		if (!details || typeof details !== "object") return undefined;
		const record = details as Record<string, unknown>;
		const usage = record.usage;
		if (!usage || typeof usage !== "object") return undefined;
		return usage as Usage;
	};

	for (const message of state.messages) {
		if (message.role === "assistant") {
			const assistantMsg = message as AssistantMessage;
			toolCalls += assistantMsg.content.filter(c => c.type === "toolCall").length;
			totalInput += assistantMsg.usage.input;
			totalOutput += assistantMsg.usage.output;
			totalReasoning += assistantMsg.usage.reasoningTokens ?? 0;
			totalCacheRead += assistantMsg.usage.cacheRead;
			totalCacheWrite += assistantMsg.usage.cacheWrite;
			totalTokens += assistantMsg.usage.totalTokens;
			totalPremiumRequests += assistantMsg.usage.premiumRequests ?? 0;
			totalCost += assistantMsg.usage.cost.total;
		}

		if (message.role === "toolResult" && message.toolName === "task") {
			const usage = getTaskToolUsage(message.details);
			if (usage) {
				totalInput += usage.input;
				totalOutput += usage.output;
				totalReasoning += usage.reasoningTokens ?? 0;
				totalCacheRead += usage.cacheRead;
				totalCacheWrite += usage.cacheWrite;
				totalTokens += usage.totalTokens;
				totalPremiumRequests += usage.premiumRequests ?? 0;
				totalCost += usage.cost.total;
			}
		}
	}

	return {
		sessionFile: session.sessionFile,
		sessionId: session.sessionId,
		userMessages,
		assistantMessages,
		toolCalls,
		toolResults,
		totalMessages: state.messages.length,
		tokens: {
			input: totalInput,
			output: totalOutput,
			reasoning: totalReasoning,
			cacheRead: totalCacheRead,
			cacheWrite: totalCacheWrite,
			total: totalTokens,
		},
		cost: totalCost,
		premiumRequests: totalPremiumRequests,
		contextUsage: session.getContextUsage(),
	};
}

/**
 * Current context usage statistics.
 * Uses the last assistant message's usage data when available,
 * otherwise estimates tokens for all messages.
 */
export function computeContextUsageBreakdown(
	session: AgentSession,
	pending: PendingContextSnapshot | undefined,
	options?: {
		contextWindow?: number;
		pendingMessages?: AgentMessage[];
	},
): ContextUsageBreakdown | undefined {
	const model = session.model;
	const rawContextWindow = options?.contextWindow ?? model?.contextWindow ?? 0;
	const contextWindow = Number.isFinite(rawContextWindow) && rawContextWindow > 0 ? rawContextWindow : 0;

	const { skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens } = computeNonMessageBreakdown(session);
	const categoryNonMessageTokens = skillsTokens + toolsTokens + systemContextTokens + systemPromptTokens;
	const currentNonMessageTokens = computeNonMessageTokens(session);

	const branchEntries = session.sessionManager.getBranch();
	const latestCompaction = getLatestCompactionEntry(branchEntries);
	const compactionIndex = latestCompaction ? branchEntries.lastIndexOf(latestCompaction) : -1;

	let usedTokens = 0;
	let anchored = false;

	const pendingMessages = options?.pendingMessages ?? [];

	// Always locate the latest real assistant-usage anchor after the last
	// compaction. Its provider-reported promptTokens is ground truth for
	// everything up to that point; only the tail after it is estimated.
	let anchorEntry: SessionMessageEntry | undefined;
	for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
		const entry = branchEntries[i];
		if (entry.type === "message" && entry.message.role === "assistant") {
			const assistant = entry.message;
			if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error" && assistant.usage) {
				anchorEntry = entry;
				break;
			}
		}
	}

	const resolvedActiveMessages = session.messages;
	let resolvedAnchorIndex = -1;
	let anchorAssistant: AssistantMessage | undefined;
	if (anchorEntry) {
		const a = anchorEntry.message as AssistantMessage;
		anchorAssistant = a;
		resolvedAnchorIndex = resolvedActiveMessages.indexOf(a);
		if (resolvedAnchorIndex === -1) {
			resolvedAnchorIndex = resolvedActiveMessages.findIndex(
				msg => msg.role === "assistant" && msg.timestamp === a.timestamp,
			);
		}
	}

	// A real anchor supersedes the in-flight estimate only once a step of the
	// CURRENT turn has produced provider usage — i.e. it resolves at or after
	// the pending cutoff. While the turn's first response is still pending (or
	// the newest real anchor predates this turn) the pending snapshot is the
	// only thing accounting for the just-submitted prompt, so it wins. This
	// keeps a long tool turn from stacking an estimate of the entire tail on
	// top of a stale turn-start prompt.
	const useAnchor =
		anchorAssistant !== undefined &&
		resolvedAnchorIndex !== -1 &&
		(!pending || resolvedAnchorIndex >= pending.cutoffCount);

	if (useAnchor && anchorAssistant) {
		const promptTokens =
			anchorAssistant.contextSnapshot?.promptTokens ?? calculatePromptTokens(anchorAssistant.usage);
		const nonMessageTokens = anchorAssistant.contextSnapshot?.nonMessageTokens ?? computeNonMessageTokens(session);
		anchored = true;
		let tailTokens = 0;
		for (let i = resolvedAnchorIndex + 1; i < resolvedActiveMessages.length; i++) {
			tailTokens += estimateTokens(resolvedActiveMessages[i]);
		}
		usedTokens =
			promptTokens +
			Math.max(0, currentNonMessageTokens - nonMessageTokens) +
			tailTokens +
			pendingMessages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
	} else if (pending) {
		anchored = true;
		let tailTokens = 0;
		if (resolvedActiveMessages.length > pending.cutoffCount) {
			for (let i = pending.cutoffCount; i < resolvedActiveMessages.length; i++) {
				tailTokens += estimateTokens(resolvedActiveMessages[i]);
			}
		}
		usedTokens =
			pending.promptTokens +
			Math.max(0, currentNonMessageTokens - pending.nonMessageTokens) +
			tailTokens +
			pendingMessages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
	}

	if (!anchored && !pending && branchEntries.length === 0) {
		// Fallback: look for the latest assistant message with usage/snapshot in session.messages (for branchless/fake sessions in tests)
		for (let i = resolvedActiveMessages.length - 1; i >= 0; i--) {
			const msg = resolvedActiveMessages[i];
			if (msg.role === "assistant" && msg.stopReason !== "aborted" && msg.stopReason !== "error" && msg.usage) {
				const promptTokens = msg.contextSnapshot?.promptTokens ?? calculatePromptTokens(msg.usage);
				const nonMessageTokens = msg.contextSnapshot?.nonMessageTokens ?? computeNonMessageTokens(session);

				let tailTokens = 0;
				for (let j = i + 1; j < resolvedActiveMessages.length; j++) {
					tailTokens += estimateTokens(resolvedActiveMessages[j]);
				}

				usedTokens =
					promptTokens +
					Math.max(0, currentNonMessageTokens - nonMessageTokens) +
					tailTokens +
					pendingMessages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
				anchored = true;
				break;
			}
		}
	}
	if (!anchored) {
		let messagesTokens = 0;
		for (const msg of resolvedActiveMessages) {
			messagesTokens += estimateTokens(msg);
		}
		usedTokens =
			currentNonMessageTokens + messagesTokens + pendingMessages.reduce((sum, msg) => sum + estimateTokens(msg), 0);
	}

	const messagesTokens = Math.max(0, usedTokens - categoryNonMessageTokens);

	return {
		contextWindow,
		anchored,
		usedTokens,
		systemPromptTokens,
		systemToolsTokens: toolsTokens,
		systemContextTokens,
		skillsTokens,
		messagesTokens,
	};
}
