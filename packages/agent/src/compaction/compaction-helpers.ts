import type {
	Api,
	ApiKey,
	AssistantMessage,
	CodexCompactionContext,
	Context,
	FetchImpl,
	Message,
	MessageAttribution,
	Model,
	ProviderSessionState,
	ServiceTier,
	SimpleStreamOptions,
	Tool,
	Usage,
} from "@veyyon/ai";
import { withAuth } from "@veyyon/ai/auth-retry";
import { ProviderHttpError } from "@veyyon/ai/error/classes";
import { createOpenAICodexCompactionRequestContext } from "@veyyon/ai/providers/openai-codex-responses";
import { detectDegenerateRepetition } from "@veyyon/ai/utils/thinking-loop";
import { Effort } from "@veyyon/catalog/effort";
import { preferredDialect } from "@veyyon/catalog/identity";
import { clampThinkingLevelForModel } from "@veyyon/catalog/model-thinking";
import { logger, prompt } from "@veyyon/utils";
import { instrumentedCompleteSimple } from "../instrumented-complete";
import { AGENT_PROMPTS } from "../prompts/registry";
import type { AgentTelemetry } from "../telemetry";
import { ThinkingLevel } from "../thinking";
import type { AgentMessage } from "../types";
import { buildCacheAlignedCompactionContext, canUseCacheAlignedCompaction } from "./cache-aligned-context";
import type { CompactionEntry, SessionEntry } from "./entries";
import { CompactionCancelledError } from "./errors";
import { type ConvertToLlm, createBranchSummaryMessage, createCustomMessage, defaultConvertToLlm } from "./messages";
import { requestRemoteCompaction } from "./remote-summarizer";
import { estimateTokens } from "./token-estimate";

export {
	type CompactionSettings,
	DEFAULT_COMPACTION_SETTINGS,
	DEFAULT_RESERVE_TOKENS,
	effectiveReserveTokens,
	isThresholdTokensClampedForWindow,
	resolveBudgetReserveTokens,
	resolveThresholdTokens,
	resolveThresholdWithOrigin,
	shouldCompact,
} from "./threshold";

export { estimateTokens } from "./token-estimate";

import {
	createFileOps,
	extractFileOpsFromMessages,
	type FileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversationForSummary,
	stripReadSelector,
	transformMessagesForSummary,
} from "./utils";

export interface CompactionDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export function extractFileOperations(
	messages: AgentMessage[],
	entries: SessionEntry[],
	prevCompactionIndex: number,
): FileOperations {
	const fileOps = createFileOps();

	if (prevCompactionIndex >= 0) {
		const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
		if (!prevCompaction.fromExtension && prevCompaction.details) {
			const details = prevCompaction.details as CompactionDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(stripReadSelector(f));
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) fileOps.edited.add(f);
			}
		}
	}

	extractFileOpsFromMessages(messages, fileOps);

	return fileOps;
}

export function getMessageFromEntry(
	entry: SessionEntry,
	excludedCustomMessageTypes?: ReadonlySet<string>,
): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "custom_message") {
		if (excludedCustomMessageTypes?.has(entry.customType)) return undefined;
		return createCustomMessage(
			entry.customType,
			entry.content,
			entry.display,
			entry.details,
			entry.timestamp,
			entry.attribution,
		);
	}
	if (entry.type === "branch_summary") {
		return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
	}
	return undefined;
}

export interface CompactionResult<T = unknown> {
	summary: string;
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	details?: T;
	preserveData?: Record<string, unknown>;
}

export function calculateContextTokens(usage: Usage): number {
	const orchestration = usage.orchestration;
	const orchestrationTotal = orchestration
		? (orchestration.input ?? 0) + (orchestration.output ?? 0) + (orchestration.cacheRead ?? 0)
		: 0;
	const raw = usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	return Math.max(0, raw - orchestrationTotal);
}

export function calculatePromptTokens(usage: Usage): number {
	const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	if (promptTokens > 0) {
		return promptTokens;
	}
	return calculateContextTokens(usage);
}

function getAssistantUsage(msg: AgentMessage): Usage | undefined {
	if (msg.role === "assistant" && "usage" in msg) {
		const assistantMsg = msg as AssistantMessage;
		if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
			return assistantMsg.usage;
		}
	}
	return undefined;
}

export function getLastAssistantUsage(entries: SessionEntry[]): Usage | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message") {
			const usage = getAssistantUsage(entry.message);
			if (usage) return usage;
		}
	}
	return undefined;
}

export function compactionContextTokens(providerContextTokens: number, storedConversationEstimate: number): number {
	return Math.max(Math.max(0, providerContextTokens), Math.max(0, storedConversationEstimate));
}

export function estimateEntriesTokens(entries: SessionEntry[], startIndex: number, endIndex: number): number {
	let total = 0;
	for (let i = startIndex; i < endIndex; i++) {
		const msg = getMessageFromEntry(entries[i]);
		if (msg) {
			total += estimateTokens(msg);
		}
	}
	return total;
}

export function findValidCutPoints(entries: SessionEntry[], startIndex: number, endIndex: number): number[] {
	const cutPoints: number[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		switch (entry.type) {
			case "message": {
				const role = entry.message.role as string;
				switch (role) {
					case "bashExecution":
					case "hookMessage":
					case "branchSummary":
					case "compactionSummary":
					case "user":
					case "assistant":
						cutPoints.push(i);
						break;
					case "toolResult":
						break;
				}
				break;
			}
			case "thinking_level_change":
			case "model_change":
			case "compaction":
			case "branch_summary":
			case "custom":
			case "custom_message":
			case "label":
		}
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			cutPoints.push(i);
		}
	}
	return cutPoints;
}

export function findTurnStartIndex(entries: SessionEntry[], entryIndex: number, startIndex: number): number {
	for (let i = entryIndex; i >= startIndex; i--) {
		const entry = entries[i];
		if (entry.type === "branch_summary" || entry.type === "custom_message") {
			return i;
		}
		if (entry.type === "message") {
			const role = entry.message.role as string;
			if (role === "user" || role === "bashExecution") {
				return i;
			}
		}
	}
	return -1;
}

export interface CutPointResult {
	firstKeptEntryIndex: number;
	turnStartIndex: number;
	isSplitTurn: boolean;
}

export function findCutPoint(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	keepRecentTokens: number,
): CutPointResult {
	const cutPoints = findValidCutPoints(entries, startIndex, endIndex);

	let accumulatedTokens = 0;
	let cutIndex = cutPoints.length > 0 ? cutPoints[0] : startIndex; // Default: keep from first message (not header)
	let crossedIndex = -1; // Entry whose tokens first pushed the tally over budget

	for (let i = endIndex - 1; i >= startIndex; i--) {
		const entry = entries[i];
		const message = getMessageFromEntry(entry);
		if (!message) continue;

		const messageTokens = estimateTokens(message);
		accumulatedTokens += messageTokens;

		if (accumulatedTokens >= keepRecentTokens) {
			crossedIndex = i;
			let found = false;
			for (let c = 0; c < cutPoints.length; c++) {
				if (cutPoints[c] >= i) {
					cutIndex = cutPoints[c];
					found = true;
					break;
				}
			}
			if (!found) {
				const turnStart = findTurnStartIndex(entries, i, startIndex);
				cutIndex = turnStart === -1 ? endIndex : turnStart;
			}
			break;
		}
	}

	while (cutIndex > startIndex && cutIndex < endIndex) {
		const prevEntry = entries[cutIndex - 1];
		if (prevEntry.type === "compaction") {
			break;
		}
		if (prevEntry.type === "message") {
			break;
		}
		cutIndex--;
	}

	if (cutIndex === startIndex && crossedIndex !== -1) {
		let nextCutPoint = -1;
		for (let c = 0; c < cutPoints.length; c++) {
			if (cutPoints[c] > startIndex) {
				nextCutPoint = cutPoints[c];
				break;
			}
		}
		cutIndex = nextCutPoint === -1 ? endIndex : nextCutPoint;
	}

	if (cutIndex >= endIndex) {
		return { firstKeptEntryIndex: endIndex, turnStartIndex: -1, isSplitTurn: false };
	}

	const cutEntry = entries[cutIndex];
	const isUserMessage = cutEntry.type === "message" && cutEntry.message.role === "user";
	const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);

	return {
		firstKeptEntryIndex: cutIndex,
		turnStartIndex,
		isSplitTurn: !isUserMessage && turnStartIndex !== -1,
	};
}

export const SUMMARIZATION_PROMPT = prompt.render(AGENT_PROMPTS["compaction/compaction-summary"].text);

export const UPDATE_SUMMARIZATION_PROMPT = prompt.render(AGENT_PROMPTS["compaction/compaction-update-summary"].text);

export const HANDOFF_DOCUMENT_PROMPT = prompt.render(AGENT_PROMPTS["compaction/handoff-document"].text);

export const AUTO_HANDOFF_THRESHOLD_FOCUS = prompt.render(
	AGENT_PROMPTS["compaction/auto-handoff-threshold-focus"].text,
);

function formatAdditionalContext(context: string[] | undefined): string {
	if (!context || context.length === 0) return "";
	const lines = context.map(line => `- ${line}`).join("\n");
	return `<additional-context>\n${lines}\n</additional-context>\n\n`;
}

function effortFromThinkingLevel(level: ThinkingLevel): Effort {
	switch (level) {
		case ThinkingLevel.Minimal:
			return Effort.Minimal;
		case ThinkingLevel.Low:
			return Effort.Low;
		case ThinkingLevel.Medium:
			return Effort.Medium;
		case ThinkingLevel.High:
			return Effort.High;
		case ThinkingLevel.XHigh:
			return Effort.XHigh;
		case ThinkingLevel.Max:
			return Effort.Max;
		case ThinkingLevel.Off:
		case ThinkingLevel.Inherit:
			throw new Error(`effortFromThinkingLevel: ${level} must be handled by caller`);
	}
}

export function resolveCompactionEffort(model: Model, level: ThinkingLevel | undefined): Effort | undefined {
	if (level === ThinkingLevel.Off) return undefined;
	const requested: Effort =
		level === undefined || level === ThinkingLevel.Inherit ? Effort.High : effortFromThinkingLevel(level);
	const clamped = clampThinkingLevelForModel(model, requested);
	if (clamped !== requested) {
		logger.warn("Compaction effort is not accepted by the model; using the nearest supported level", {
			model: `${model.provider}/${model.id}`,
			requested,
			using: clamped ?? "provider default",
		});
	}
	return clamped;
}

export function createSummarizationError(prefix: string, response: AssistantMessage, options?: SummaryOptions): Error {
	const rawDetail = response.errorMessage || "Unknown error";
	const detail = options ? sanitizeCompactionProviderText(rawDetail, options) : rawDetail;
	const text = `${prefix}: ${detail}`;
	return response.errorStatus === undefined ? new Error(text) : new ProviderHttpError(text, response.errorStatus);
}

export function shouldRetryHandoffWithAutoToolChoice(response: AssistantMessage): boolean {
	if (response.errorStatus !== 400) return false;
	const message = response.errorMessage ?? "";
	return /\btool_choice\b/i.test(message) && /\bauto\b/i.test(message) && /\bsupported\b/i.test(message);
}

export interface SummaryOptions {
	promptOverride?: string;
	extraContext?: string[];
	remoteEndpoint?: string;
	remoteInstructions?: string;
	initiatorOverride?: MessageAttribution;
	metadata?: Record<string, unknown>;
	convertToLlm?: ConvertToLlm;
	telemetry?: AgentTelemetry;
	thinkingLevel?: ThinkingLevel;
	sessionId?: string;
	promptCacheKey?: string;
	serviceTier?: ServiceTier;
	providerSessionState?: Map<string, ProviderSessionState>;
	codexCompaction?: CodexCompactionContext;
	tools?: Tool[];
	sessionSystemPrompt?: string[];
	sessionMessages?: Message[];
	fetch?: FetchImpl;
	obfuscateProviderText?: (text: string) => string;
	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
}

export function localCodexCompaction(options: SummaryOptions | undefined) {
	return createOpenAICodexCompactionRequestContext({
		context: options?.codexCompaction,
		implementation: "responses",
	});
}

function sanitizeCompactionProviderText(text: string, options: SummaryOptions | undefined): string {
	const transform = options?.obfuscateProviderText;
	if (!transform) return text;
	try {
		const sanitized = transform(text);
		if (typeof sanitized !== "string") throw new TypeError("invalid transform result");
		return sanitized;
	} catch {
		throw new Error("Compaction provider payload sanitization failed");
	}
}

export function transformSummarySourceMessages(messages: Message[], options: SummaryOptions | undefined): Message[] {
	if (!options?.obfuscateProviderText) return messages;
	return transformMessagesForSummary(messages, text => sanitizeCompactionProviderText(text, options));
}

export function throwIfCompactionCancelled(response: AssistantMessage): void {
	if (response.stopReason === "aborted") throw new CompactionCancelledError();
}

export function buildCompactionProviderContext(
	systemPrompt: string,
	promptText: string,
	options: SummaryOptions | undefined,
): Context {
	return {
		systemPrompt: [sanitizeCompactionProviderText(systemPrompt, options)],
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: sanitizeCompactionProviderText(promptText, options) }],
				timestamp: Date.now(),
			},
		],
	};
}

function formatLegacyArchiveText(archiveText: string): string {
	return prompt.render(AGENT_PROMPTS["compaction/legacy-archive-context"].text, { archiveText });
}

export function mergePreviousSummaryWithLegacyArchive(
	previousSummary: string | undefined,
	archiveText: string | undefined,
): string | undefined {
	if (!archiveText) return previousSummary;
	const archiveSummary = formatLegacyArchiveText(archiveText);
	return previousSummary ? `${previousSummary}\n\n${archiveSummary}` : archiveSummary;
}

export const WINDOW_PROPORTIONAL_RESERVE_SHARE = 0.15;

export function summaryOutputBudget(model: Model, reserveTokens: number, share: number): number {
	const contextWindow = model.contextWindow ?? 0;
	const proportionalReserve = Math.max(1, Math.floor(contextWindow * WINDOW_PROPORTIONAL_RESERVE_SHARE));
	const impossibleForWindow = contextWindow > 0 && reserveTokens >= contextWindow - proportionalReserve;
	return Math.floor(share * (impossibleForWindow ? proportionalReserve : reserveTokens));
}

export function buildSummaryPrompt(
	currentMessages: AgentMessage[],
	model: Model,
	reserveTokens: number,
	customInstructions: string | undefined,
	previousSummary: string | undefined,
	options: SummaryOptions | undefined,
	cacheAligned: boolean,
): { promptText: string; maxTokens: number } {
	let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
	if (options?.promptOverride) basePrompt = options.promptOverride;
	if (customInstructions) basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;

	const conversationText = cacheAligned
		? undefined
		: serializeConversationForSummary(
				transformSummarySourceMessages((options?.convertToLlm ?? defaultConvertToLlm)(currentMessages), options),
				preferredDialect(model.id),
			);
	let promptText =
		conversationText === undefined
			? `${SUMMARIZATION_SYSTEM_PROMPT}\n\n`
			: `<conversation>\n${conversationText}\n</conversation>\n\n`;
	if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
	promptText += formatAdditionalContext(options?.extraContext);
	promptText += basePrompt;
	return { promptText, maxTokens: summaryOutputBudget(model, reserveTokens, 0.8) };
}

export async function generateSummary(
	currentMessages: AgentMessage[],
	model: Model,
	reserveTokens: number,
	apiKey: ApiKey,
	signal?: AbortSignal,
	customInstructions?: string,
	previousSummary?: string,
	options?: SummaryOptions,
): Promise<string> {
	const sessionSystemPrompt = options?.sessionSystemPrompt;
	const sessionMessages = options?.sessionMessages;
	const cacheAligned = canUseCacheAlignedCompaction({ model, sessionSystemPrompt, sessionMessages });
	const { promptText, maxTokens } = buildSummaryPrompt(
		currentMessages,
		model,
		reserveTokens,
		customInstructions,
		previousSummary,
		options,
		cacheAligned,
	);

	if (options?.remoteEndpoint) {
		const endpoint = options.remoteEndpoint;
		const remote = await withAuth(
			apiKey,
			key => {
				const request = {
					systemPrompt: sanitizeCompactionProviderText(SUMMARIZATION_SYSTEM_PROMPT, options),
					prompt: sanitizeCompactionProviderText(promptText, options),
				};
				return requestRemoteCompaction(endpoint, request, signal, {
					fetch: options.fetch,
					model,
					apiKey: key,
					sanitizeErrorText: text => sanitizeCompactionProviderText(text, options),
				});
			},
			{ signal, missingKeyMessage: "Remote compaction credentials unavailable" },
		);
		return remote.summary;
	}

	const response = await withAuth(
		apiKey,
		async key => {
			const attemptResponse = await instrumentedCompleteSimple(
				model,
				cacheAligned && sessionSystemPrompt && sessionMessages
					? buildCacheAlignedCompactionContext({
							sessionSystemPrompt,
							sessionMessages,
							tools: options?.tools,
							instruction: promptText,
							sanitize: text => sanitizeCompactionProviderText(text, options),
						})
					: buildCompactionProviderContext(SUMMARIZATION_SYSTEM_PROMPT, promptText, options),
				{
					maxTokens,
					signal,
					apiKey: key,
					reasoning: resolveCompactionEffort(model, options?.thinkingLevel),
					initiatorOverride: options?.initiatorOverride,
					metadata: options?.metadata,
					fetch: options?.fetch,
					sessionId: options?.sessionId,
					promptCacheKey: options?.promptCacheKey,
					providerSessionState: options?.providerSessionState,
					codexCompaction: localCodexCompaction(options),
					serviceTier: options?.serviceTier,
				},
				{ telemetry: options?.telemetry, oneshotKind: "compaction_summary", completeImpl: options?.completeImpl },
			);
			throwIfCompactionCancelled(attemptResponse);
			if (attemptResponse.stopReason === "error") {
				throw createSummarizationError("Summarization failed", attemptResponse, options);
			}
			return attemptResponse;
		},
		{ signal },
	);

	const textContent = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");

	if (textContent.trim().length === 0) {
		throw new Error(
			`Summarization returned an empty summary (stopReason: ${response.stopReason}). ` +
				`The history was NOT compacted. Retry, or lower the compaction thinking level so the ` +
				`model spends its budget on the summary instead of reasoning.`,
		);
	}

	const degeneracy = detectDegenerateRepetition(textContent);
	if (degeneracy) {
		throw new Error(
			`Summarization returned a degenerate summary (${degeneracy}). ` +
				`The history was NOT compacted. Retry; if it recurs, compact with a different model.`,
		);
	}

	return textContent;
}
