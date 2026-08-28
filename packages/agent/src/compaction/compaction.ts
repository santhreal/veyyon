import type {
	Api,
	ApiKey,
	AssistantMessage,
	Context,
	Message,
	MessageAttribution,
	Model,
	ServiceTier,
	SimpleStreamOptions,
	TextContent,
	Tool,
	ToolResultMessage,
} from "@veyyon/ai";
import { withAuth } from "@veyyon/ai/auth-retry";
import { detectDegenerateRepetition } from "@veyyon/ai/utils/thinking-loop";
import { preferredDialect } from "@veyyon/catalog/identity";
import { logger, prompt } from "@veyyon/utils";
import { instrumentedCompleteSimple } from "../instrumented-complete";
import { AGENT_PROMPTS } from "../prompts/registry";
import type { AgentTelemetry } from "../telemetry";
import type { ThinkingLevel } from "../thinking";
import { countTokens } from "../tokenizer";
import type { AgentMessage } from "../types";
import { canUseCacheAlignedCompaction, estimateCacheAlignedRequestTokens } from "./cache-aligned-context";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "./entries";
import { KEEP_NOTHING_ENTRY_ID } from "./entries";
import { LEGACY_REMOTE_PRESERVE_KEYS } from "./legacy-provider-native";
import { hasLegacyArchive, legacyArchiveSourceText, stripLegacyArchive } from "./legacy-snapcompact-archive";
import { type ConvertToLlm, defaultConvertToLlm } from "./messages";
import {
	getRemoteCompactionPreserveData,
	REMOTE_COMPACTION_PRESERVE_KEY,
	stripRemoteCompactionPreserveData,
} from "./remote-compaction-entry";
import {
	AUTO_COMPACTION_THRESHOLD,
	type CompactionSettings,
	DEFAULT_RESERVE_TOKENS,
	resolveThresholdTokens,
} from "./threshold";
import { estimateTokens } from "./token-estimate";
import { collectToolCallsById, isSkillReadToolResult } from "./tool-protection";

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
	buildCompactionProviderContext,
	buildSummaryPrompt,
	type CompactionDetails,
	type CompactionResult,
	calculateContextTokens,
	calculatePromptTokens,
	createSummarizationError,
	estimateEntriesTokens,
	extractFileOperations,
	findCutPoint,
	generateSummary,
	getLastAssistantUsage,
	getMessageFromEntry,
	HANDOFF_DOCUMENT_PROMPT,
	localCodexCompaction,
	mergePreviousSummaryWithLegacyArchive,
	resolveCompactionEffort,
	type SummaryOptions,
	shouldRetryHandoffWithAutoToolChoice,
	summaryOutputBudget,
	throwIfCompactionCancelled,
	transformSummarySourceMessages,
} from "./compaction-helpers";
import {
	computeFileLists,
	extractFileOpsFromMessages,
	type FileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversationForSummary,
	upsertFileOperations,
} from "./utils";

export {
	AUTO_HANDOFF_THRESHOLD_FOCUS,
	type CompactionDetails,
	type CompactionResult,
	type CutPointResult,
	calculateContextTokens,
	calculatePromptTokens,
	compactionContextTokens,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	getLastAssistantUsage,
	type SummaryOptions,
} from "./compaction-helpers";

export interface HandoffOptions {
	systemPrompt: string[];
	tools?: Tool[];
	customInstructions?: string;
	convertToLlm?: ConvertToLlm;
	initiatorOverride?: MessageAttribution;
	metadata?: Record<string, unknown>;
	fileOps?: FileOperations;
	telemetry?: AgentTelemetry;
	thinkingLevel?: ThinkingLevel;
	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
	sessionId?: string;
	conversationId?: string;
	promptCacheKey?: string;
	serviceTier?: ServiceTier;
}

export function renderHandoffPrompt(customInstructions?: string): string {
	if (!customInstructions) return HANDOFF_DOCUMENT_PROMPT;
	return prompt.render(AGENT_PROMPTS["compaction/handoff-document"].text, {
		additionalFocus: customInstructions,
	});
}

export interface HandoffFromContextOptions {
	streamOptions: SimpleStreamOptions;
	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
	telemetry?: AgentTelemetry;
	thinkingLevel?: ThinkingLevel;
}

export async function generateHandoffFromContext(
	context: Context,
	model: Model,
	options: HandoffFromContextOptions,
): Promise<string> {
	const requestOptions = {
		...options.streamOptions,
		reasoning: resolveCompactionEffort(model, options.thinkingLevel),
		toolChoice: "none" as const,
	};
	let response = await instrumentedCompleteSimple(model, context, requestOptions, {
		telemetry: options.telemetry,
		oneshotKind: "handoff",
		completeImpl: options.completeImpl,
	});
	if (response.stopReason === "error" && shouldRetryHandoffWithAutoToolChoice(response)) {
		response = await instrumentedCompleteSimple(
			model,
			context,
			{ ...requestOptions, toolChoice: "auto" },
			{ telemetry: options.telemetry, oneshotKind: "handoff", completeImpl: options.completeImpl },
		);
	}

	throwIfCompactionCancelled(response);
	if (response.stopReason === "error") {
		throw createSummarizationError("Handoff generation failed", response);
	}

	const document = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");

	if (document.trim().length === 0) {
		throw new Error(
			`Handoff generation returned an empty document (stopReason: ${response.stopReason}). ` +
				`Retry the handoff, or use the \`summary\` strategy if it keeps recurring.`,
		);
	}

	const degeneracy = detectDegenerateRepetition(document);
	if (degeneracy) {
		throw new Error(
			`Handoff generation returned a degenerate document (${degeneracy}). ` +
				`Retry the handoff, or use the \`summary\` strategy if it keeps recurring.`,
		);
	}

	return document;
}

export async function generateHandoff(
	messages: AgentMessage[],
	model: Model,
	apiKey: ApiKey,
	options: HandoffOptions,
	signal?: AbortSignal,
): Promise<string> {
	const llmMessages = (options.convertToLlm ?? defaultConvertToLlm)(messages);
	const requestMessages: Message[] = [
		...llmMessages,
		{
			role: "user",
			content: [{ type: "text", text: renderHandoffPrompt(options.customInstructions) }],
			attribution: "agent",
			timestamp: Date.now(),
		},
	];

	const document = await generateHandoffFromContext(
		{ systemPrompt: options.systemPrompt, messages: requestMessages, tools: options.tools },
		model,
		{
			streamOptions: {
				apiKey,
				signal,
				initiatorOverride: options.initiatorOverride,
				metadata: options.metadata,
				sessionId: options.sessionId,
				conversationId: options.conversationId,
				promptCacheKey: options.promptCacheKey,
				serviceTier: options.serviceTier,
			},
			telemetry: options.telemetry,
			thinkingLevel: options.thinkingLevel,
			completeImpl: options.completeImpl,
		},
	);

	if (!options.fileOps) return document;
	const { readFiles, modifiedFiles } = computeFileLists(options.fileOps);
	return upsertFileOperations(document, readFiles, modifiedFiles, options.fileOps.read);
}

export interface RemoteCompactionChain {
	previousPreserveData: Record<string, unknown>;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
}

export interface CompactionPreparation {
	firstKeptEntryId: string;
	messagesToSummarize: AgentMessage[];
	turnPrefixMessages: AgentMessage[];
	recentMessages: AgentMessage[];
	isSplitTurn: boolean;
	tokensBefore: number;
	previousSummary?: string;
	previousPreserveData?: Record<string, unknown>;
	remoteChain?: RemoteCompactionChain;
	tailElisions?: TailElision[];
	fileOps: FileOperations;
	settings: CompactionSettings;
}

const NON_REUSABLE_SUMMARY_KEYS: readonly string[] = [...LEGACY_REMOTE_PRESERVE_KEYS, REMOTE_COMPACTION_PRESERVE_KEY];

function hasReusableSummary(preserveData: Record<string, unknown> | undefined): boolean {
	if (!preserveData) return true;
	return !NON_REUSABLE_SUMMARY_KEYS.some(key => key in preserveData);
}

export interface CompactionPreparationOptions {
	excludedCustomMessageTypes?: ReadonlySet<string>;
	nonMessageTokens?: number;
	contextWindow?: number;
}

export function assertValidCompactionResult(preparation: CompactionPreparation, result: CompactionResult): void {
	if (typeof result.summary !== "string" || result.summary.trim().length === 0) {
		if (!getRemoteCompactionPreserveData(result.preserveData)) {
			const claimedRemote =
				result.preserveData !== undefined && REMOTE_COMPACTION_PRESERVE_KEY in result.preserveData;
			throw new Error(
				claimedRemote
					? "Compaction failed: the summary is empty and the server-side compaction window stored beside it is malformed, so nothing replaces the discarded history; history was left unchanged."
					: "Compaction failed: the generated summary is empty and no server-side compaction window was stored, so nothing replaces the discarded history; history was left unchanged.",
			);
		}
	}
	for (const [field, text] of [
		["summary", result.summary],
		["shortSummary", result.shortSummary],
	] as const) {
		if (typeof text !== "string") continue;
		const degeneracy = detectDegenerateRepetition(text);
		if (degeneracy) {
			throw new Error(
				`Compaction failed: the generated ${field} is degenerate (${degeneracy}), so it describes nothing the discarded history held; history was left unchanged.`,
			);
		}
	}
	if (result.firstKeptEntryId !== preparation.firstKeptEntryId) {
		throw new Error(
			`Compaction failed: firstKeptEntryId ${JSON.stringify(result.firstKeptEntryId)} does not match the safe cut point ${JSON.stringify(preparation.firstKeptEntryId)}; history was left unchanged.`,
		);
	}
	if (!Number.isFinite(result.tokensBefore) || result.tokensBefore < 0) {
		throw new Error(
			`Compaction failed: tokensBefore must be a finite non-negative number, received ${JSON.stringify(result.tokensBefore)}; history was left unchanged.`,
		);
	}
}

export function estimateCompactionRequestTokens(
	preparation: CompactionPreparation,
	model: Model,
	customInstructions?: string,
	options?: SummaryOptions,
): number {
	const reserveTokens = preparation.settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS;
	const previousSummary = mergePreviousSummaryWithLegacyArchive(
		preparation.previousSummary,
		legacyArchiveSourceText(preparation.previousPreserveData),
	);
	const requests: number[] = [];
	const cacheAligned = canUseCacheAlignedCompaction({
		model,
		sessionSystemPrompt: options?.sessionSystemPrompt,
		sessionMessages: options?.sessionMessages,
	});
	const hasHistoryRequest =
		preparation.messagesToSummarize.length > 0 || (preparation.isSplitTurn && previousSummary !== undefined);
	if (hasHistoryRequest) {
		const built = buildSummaryPrompt(
			preparation.messagesToSummarize,
			model,
			reserveTokens,
			customInstructions,
			previousSummary,
			options,
			cacheAligned,
		);
		const inputTokens =
			cacheAligned && options?.sessionSystemPrompt && options?.sessionMessages
				? estimateCacheAlignedRequestTokens({
						sessionSystemPrompt: options.sessionSystemPrompt,
						sessionMessages: options.sessionMessages,
						instruction: built.promptText,
					})
				: countTokens([SUMMARIZATION_SYSTEM_PROMPT, built.promptText]);
		requests.push(inputTokens + built.maxTokens);
	}
	if (preparation.isSplitTurn && preparation.turnPrefixMessages.length > 0) {
		const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(preparation.turnPrefixMessages);
		const conversationText = serializeConversationForSummary(
			transformSummarySourceMessages(llmMessages, options),
			preferredDialect(model.id),
		);
		const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
		requests.push(
			countTokens([SUMMARIZATION_SYSTEM_PROMPT, promptText]) + summaryOutputBudget(model, reserveTokens, 0.5),
		);
	}
	return requests.length > 0 ? Math.max(...requests) : 0;
}

export interface TailElision {
	entryId: string;
	toolName: string;
	tokens: number;
	originalText: string;
	originalMessage: ToolResultMessage;
	message: ToolResultMessage;
}

export function renderTailElisionMarker(toolName: string, tokens: number, artifactId?: string): string {
	const recovery = artifactId ? `; recover the full output at artifact://${artifactId}` : "";
	return `[output elided by compaction: ~${tokens} tokens of "${toolName}" output removed to keep the retained tail within budget${recovery}]`;
}

export function renderTailElisionArtifact(elisions: readonly TailElision[]): string {
	const parts: string[] = [];
	for (let i = 0; i < elisions.length; i++) {
		const elision = elisions[i];
		parts.push(
			`### elision ${i + 1} (${elision.toolName}, ~${elision.tokens} tokens, entry ${elision.entryId})`,
			"",
			elision.originalText,
			"",
		);
	}
	return parts.join("\n");
}

export function rollbackTailElisions(entries: SessionEntry[], elisions: readonly TailElision[]): number {
	let restored = 0;
	for (const elision of elisions) {
		const entry = entries.find(e => e.id === elision.entryId);
		if (entry?.type !== "message") continue;
		if (entry.message !== elision.message) continue;
		entry.message = elision.originalMessage;
		restored++;
	}
	return restored;
}

const TAIL_ELISION_MIN_TOKENS = 100;

function tailToolResultText(message: ToolResultMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
}

function elideTailToolResults(
	entries: SessionEntry[],
	startIndex: number,
	endIndex: number,
	budgetTokens: number,
	excludedCustomMessageTypes?: ReadonlySet<string>,
): TailElision[] {
	if (startIndex >= endIndex) return [];

	let tailTokens = 0;
	for (let i = startIndex; i < endIndex; i++) {
		const msg = getMessageFromEntry(entries[i], excludedCustomMessageTypes);
		if (msg) tailTokens += estimateTokens(msg);
	}
	if (tailTokens <= budgetTokens) return [];

	const toolCallsById = collectToolCallsById(entries);
	interface Candidate {
		entry: SessionMessageEntry;
		message: ToolResultMessage;
		tokens: number;
	}
	const candidates: Candidate[] = [];
	for (let i = startIndex; i < endIndex; i++) {
		const entry = entries[i];
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		const message = entry.message as ToolResultMessage;
		if (message.isError === true) continue;
		if (message.prunedAt !== undefined) continue;
		if (isSkillReadToolResult({ toolResult: message, toolCall: toolCallsById.get(message.toolCallId) })) continue;
		const tokens = estimateTokens(message as AgentMessage);
		if (tokens <= TAIL_ELISION_MIN_TOKENS) continue;
		candidates.push({ entry: entry as SessionMessageEntry, message, tokens });
	}
	candidates.sort((a, b) => b.tokens - a.tokens);

	const elisions: TailElision[] = [];
	for (const candidate of candidates) {
		if (tailTokens <= budgetTokens) break;
		const replacement: ToolResultMessage = {
			...candidate.message,
			content: [{ type: "text", text: renderTailElisionMarker(candidate.message.toolName, candidate.tokens) }],
			prunedAt: Date.now(),
		};
		candidate.entry.message = replacement;
		tailTokens -= Math.max(0, candidate.tokens - estimateTokens({ ...replacement } as AgentMessage));
		elisions.push({
			entryId: candidate.entry.id,
			toolName: candidate.message.toolName,
			tokens: candidate.tokens,
			originalText: tailToolResultText(candidate.message),
			originalMessage: candidate.message,
			message: replacement,
		});
	}
	return elisions;
}

export function prepareCompaction(
	pathEntries: SessionEntry[],
	settings: CompactionSettings,
	options?: CompactionPreparationOptions,
): CompactionPreparation | undefined {
	if (pathEntries.length > 0 && pathEntries[pathEntries.length - 1].type === "compaction") {
		return undefined;
	}

	let prevCompactionIndex = -1;
	let remoteCompactionIndex = -1;
	for (let i = pathEntries.length - 1; i >= 0; i--) {
		if (pathEntries[i].type !== "compaction") continue;
		const entry = pathEntries[i] as CompactionEntry;
		if (!hasReusableSummary(entry.preserveData)) {
			if (remoteCompactionIndex === -1 && getRemoteCompactionPreserveData(entry.preserveData)) {
				remoteCompactionIndex = i;
			}
			continue;
		}
		prevCompactionIndex = i;
		break;
	}
	const boundaryStart = prevCompactionIndex + 1;
	const boundaryEnd = pathEntries.length;

	const lastUsage = getLastAssistantUsage(pathEntries);
	const tokensBefore = lastUsage ? calculateContextTokens(lastUsage) : 0;
	let keepRecentTokens = settings.keepRecentTokens;
	const nonMessageTokens = options?.nonMessageTokens;
	const contextWindow = options?.contextWindow;
	if (
		settings.threshold === AUTO_COMPACTION_THRESHOLD &&
		nonMessageTokens !== undefined &&
		contextWindow !== undefined &&
		contextWindow > 0
	) {
		const conversationBudget = resolveThresholdTokens(contextWindow, settings) - nonMessageTokens;
		if (conversationBudget > 0) keepRecentTokens = Math.min(keepRecentTokens, conversationBudget);
	}
	if (lastUsage) {
		const estimatedTokens = estimateEntriesTokens(pathEntries, boundaryStart, boundaryEnd);
		const conversationPromptTokens = calculatePromptTokens(lastUsage) - (nonMessageTokens ?? 0);
		if (conversationPromptTokens < 0) {
			logger.warn("compaction: non-message token estimate exceeds the provider's whole prompt count", {
				nonMessageTokens,
				promptTokens: calculatePromptTokens(lastUsage),
				estimatedTokens,
			});
		}
		const ratio =
			nonMessageTokens !== undefined && estimatedTokens > 0 ? conversationPromptTokens / estimatedTokens : 0;
		if (Number.isFinite(ratio) && ratio > 1) {
			keepRecentTokens = Math.max(1, Math.floor(keepRecentTokens / ratio));
		}
	}

	const cutPoint = findCutPoint(pathEntries, boundaryStart, boundaryEnd, keepRecentTokens);

	const keepsNothing = cutPoint.firstKeptEntryIndex >= boundaryEnd;
	const firstKeptEntry = keepsNothing ? undefined : pathEntries[cutPoint.firstKeptEntryIndex];
	if (!keepsNothing && !firstKeptEntry?.id) {
		return undefined; // Session needs migration
	}
	const firstKeptEntryId = keepsNothing ? KEEP_NOTHING_ENTRY_ID : (firstKeptEntry as SessionEntry).id;

	const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;

	const messagesToSummarize: AgentMessage[] = [];
	for (let i = boundaryStart; i < historyEnd; i++) {
		const msg = getMessageFromEntry(pathEntries[i], options?.excludedCustomMessageTypes);
		if (msg) messagesToSummarize.push(msg);
	}

	const turnPrefixMessages: AgentMessage[] = [];
	if (cutPoint.isSplitTurn) {
		for (let i = cutPoint.turnStartIndex; i < cutPoint.firstKeptEntryIndex; i++) {
			const msg = getMessageFromEntry(pathEntries[i], options?.excludedCustomMessageTypes);
			if (msg) turnPrefixMessages.push(msg);
		}
	}

	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) {
		return undefined;
	}

	const tailElisions = elideTailToolResults(
		pathEntries,
		cutPoint.firstKeptEntryIndex,
		boundaryEnd,
		keepRecentTokens,
		options?.excludedCustomMessageTypes,
	);

	const recentMessages: AgentMessage[] = [];
	for (let i = cutPoint.firstKeptEntryIndex; i < boundaryEnd; i++) {
		const msg = getMessageFromEntry(pathEntries[i], options?.excludedCustomMessageTypes);
		if (msg) recentMessages.push(msg);
	}

	let previousSummary: string | undefined;
	let previousPreserveData: Record<string, unknown> | undefined;
	if (prevCompactionIndex >= 0) {
		const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
		previousSummary = prevCompaction.summary;
		previousPreserveData = prevCompaction.preserveData;
	}

	const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);

	if (cutPoint.isSplitTurn) {
		extractFileOpsFromMessages(turnPrefixMessages, fileOps);
	}

	let remoteChain: RemoteCompactionChain | undefined;
	if (remoteCompactionIndex >= 0 && remoteCompactionIndex < historyEnd) {
		const chainMessages: AgentMessage[] = [];
		for (let i = remoteCompactionIndex + 1; i < historyEnd; i++) {
			const msg = getMessageFromEntry(pathEntries[i], options?.excludedCustomMessageTypes);
			if (msg) chainMessages.push(msg);
		}
		remoteChain = {
			previousPreserveData: (pathEntries[remoteCompactionIndex] as CompactionEntry).preserveData ?? {},
			messagesToSummarize: chainMessages,
			turnPrefixMessages,
		};
	}

	return {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		recentMessages,
		tailElisions,
		isSplitTurn: cutPoint.isSplitTurn,
		tokensBefore,
		previousSummary,
		previousPreserveData,
		remoteChain,
		fileOps,
		settings,
	};
}

const TURN_PREFIX_SUMMARIZATION_PROMPT = prompt.render(AGENT_PROMPTS["compaction/compaction-turn-prefix"].text);

export async function compact(
	preparation: CompactionPreparation,
	model: Model,
	apiKey: ApiKey,
	customInstructions?: string,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<CompactionResult> {
	const {
		firstKeptEntryId,
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn,
		tokensBefore,
		previousSummary,
		previousPreserveData,
		fileOps,
		settings,
	} = preparation;

	const reserveTokens = settings.reserveTokens ?? DEFAULT_RESERVE_TOKENS;

	const summaryOptions: SummaryOptions = {
		promptOverride: options?.promptOverride,
		extraContext: options?.extraContext,
		remoteEndpoint: settings.remoteEndpoint,
		remoteInstructions: options?.remoteInstructions,
		initiatorOverride: options?.initiatorOverride,
		metadata: options?.metadata,
		convertToLlm: options?.convertToLlm,
		telemetry: options?.telemetry,
		thinkingLevel: options?.thinkingLevel,
		sessionId: options?.sessionId,
		promptCacheKey: options?.promptCacheKey,
		serviceTier: options?.serviceTier,
		providerSessionState: options?.providerSessionState,
		codexCompaction: options?.codexCompaction,
		tools: options?.tools,
		sessionSystemPrompt: options?.sessionSystemPrompt,
		sessionMessages: options?.sessionMessages,
		fetch: options?.fetch,
		completeImpl: options?.completeImpl,
		obfuscateProviderText: options?.obfuscateProviderText,
	};

	const previousLegacyArchiveText = legacyArchiveSourceText(previousPreserveData);
	const previousSummaryForCompaction = mergePreviousSummaryWithLegacyArchive(
		previousSummary,
		previousLegacyArchiveText,
	);
	let preserveData = previousPreserveData;
	if (preserveData !== undefined) {
		const carried: Record<string, unknown> = { ...preserveData };
		let dropped = false;
		for (const key of LEGACY_REMOTE_PRESERVE_KEYS) {
			if (key in carried) {
				delete carried[key];
				dropped = true;
			}
		}
		if (dropped) preserveData = Object.keys(carried).length > 0 ? carried : undefined;
	}
	preserveData = stripRemoteCompactionPreserveData(preserveData);

	let summary: string;

	if (isSplitTurn && turnPrefixMessages.length > 0) {
		const [historyResult, turnPrefixResult] = await Promise.all([
			messagesToSummarize.length > 0 || previousSummaryForCompaction
				? generateSummary(
						messagesToSummarize,
						model,
						reserveTokens,
						apiKey,
						signal,
						customInstructions,
						previousSummaryForCompaction,
						summaryOptions,
					)
				: Promise.resolve("No prior history."),
			generateTurnPrefixSummary(turnPrefixMessages, model, reserveTokens, apiKey, signal, summaryOptions),
		]);
		summary = `${historyResult}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult}`;
	} else if (messagesToSummarize.length > 0) {
		summary = await generateSummary(
			messagesToSummarize,
			model,
			reserveTokens,
			apiKey,
			signal,
			customInstructions,
			previousSummaryForCompaction,
			summaryOptions,
		);
	} else if (previousSummaryForCompaction) {
		summary = previousSummaryForCompaction;
	} else {
		summary = "No prior history.";
	}

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary = upsertFileOperations(summary, readFiles, modifiedFiles, fileOps.read);

	if (!firstKeptEntryId) {
		throw new Error("First kept entry has no ID - session may need migration");
	}

	const finalPreserveData = hasLegacyArchive(previousPreserveData) ? stripLegacyArchive(preserveData) : preserveData;

	return {
		summary,
		firstKeptEntryId,
		tokensBefore,
		details: { readFiles, modifiedFiles } as CompactionDetails,
		preserveData: finalPreserveData,
	};
}

async function generateTurnPrefixSummary(
	messages: AgentMessage[],
	model: Model,
	reserveTokens: number,
	apiKey: ApiKey,
	signal?: AbortSignal,
	options?: SummaryOptions,
): Promise<string> {
	const maxTokens = summaryOutputBudget(model, reserveTokens, 0.5);

	const llmMessages = (options?.convertToLlm ?? defaultConvertToLlm)(messages);
	const conversationText = serializeConversationForSummary(
		transformSummarySourceMessages(llmMessages, options),
		preferredDialect(model.id),
	);
	const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;

	const response = await withAuth(
		apiKey,
		async key => {
			const attemptResponse = await instrumentedCompleteSimple(
				model,
				buildCompactionProviderContext(SUMMARIZATION_SYSTEM_PROMPT, promptText, options),
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
				{
					telemetry: options?.telemetry,
					oneshotKind: "compaction_turn_prefix",
					completeImpl: options?.completeImpl,
				},
			);
			throwIfCompactionCancelled(attemptResponse);
			if (attemptResponse.stopReason === "error") {
				throw createSummarizationError("Turn prefix summarization failed", attemptResponse, options);
			}
			return attemptResponse;
		},
		{ signal },
	);

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}
