import type { Api, ApiKey, AssistantMessage, Context, Model, ServiceTier, SimpleStreamOptions } from "@veyyon/ai";
import { detectDegenerateRepetition } from "@veyyon/ai/utils/thinking-loop";
import { preferredDialect } from "@veyyon/catalog/identity";
import { logger, prompt } from "@veyyon/utils";
import { instrumentedCompleteSimple } from "../instrumented-complete";
import { AGENT_PROMPTS } from "../prompts/registry";
import type { AgentTelemetry } from "../telemetry";
import type { AgentMessage } from "../types";
import type { ReadonlySessionManager, SessionEntry } from "./entries";
import {
	type ConvertToLlm,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
	defaultConvertToLlm,
} from "./messages";
import { estimateTokens } from "./token-estimate";
import {
	computeFileLists,
	createFileOps,
	extractFileOpsFromMessages,
	type FileOperations,
	SUMMARIZATION_SYSTEM_PROMPT,
	serializeConversationForSummary,
	stripReadSelector,
	truncateToolResultForSummary,
	upsertFileOperations,
} from "./utils";

export interface BranchSummaryResult {
	summary?: string;
	readFiles?: string[];
	modifiedFiles?: string[];
	aborted?: boolean;
	error?: string;
}

export interface BranchSummaryDetails {
	readFiles: string[];
	modifiedFiles: string[];
}

export type { FileOperations } from "./utils";

export interface BranchPreparation {
	messages: AgentMessage[];
	fileOps: FileOperations;
	totalTokens: number;
}

export interface CollectEntriesResult {
	entries: SessionEntry[];
	commonAncestorId: string | null;
}

export interface GenerateBranchSummaryOptions {
	model: Model;
	apiKey: ApiKey;
	signal: AbortSignal;
	customInstructions?: string;
	reserveTokens?: number;
	metadata?: Record<string, unknown>;
	convertToLlm?: ConvertToLlm;
	resolveObfuscateProviderText?: () => (text: string) => string;
	onPayload?: SimpleStreamOptions["onPayload"];
	telemetry?: AgentTelemetry;
	completeImpl?: <TApi extends Api>(
		model: Model<TApi>,
		ctx: Context,
		options: SimpleStreamOptions,
	) => Promise<AssistantMessage>;
	serviceTier?: ServiceTier;
	sessionId?: string;
	conversationId?: string;
	promptCacheKey?: string;
}

export function collectEntriesForBranchSummary(
	session: ReadonlySessionManager,
	oldLeafId: string | null,
	targetId: string,
): CollectEntriesResult {
	if (!oldLeafId) {
		return { entries: [], commonAncestorId: null };
	}

	const oldPath = new Set(session.getBranch(oldLeafId).map(e => e.id));
	const targetPath = session.getBranch(targetId);

	let commonAncestorId: string | null = null;
	for (let i = targetPath.length - 1; i >= 0; i--) {
		if (oldPath.has(targetPath[i].id)) {
			commonAncestorId = targetPath[i].id;
			break;
		}
	}

	const entries: SessionEntry[] = [];
	let current: string | null = oldLeafId;

	const visited = new Set<string>();
	while (current && current !== commonAncestorId && !visited.has(current)) {
		visited.add(current);
		const entry = session.getEntry(current);
		if (!entry) break;
		entries.push(entry);
		current = entry.parentId;
	}

	entries.reverse();

	return { entries, commonAncestorId };
}

function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
	switch (entry.type) {
		case "message":
			if (entry.message.role === "toolResult" && entry.message.useless === true && entry.message.isError !== true) {
				return undefined;
			}
			return entry.message;

		case "custom_message":
			return createCustomMessage(
				entry.customType,
				entry.content,
				entry.display,
				entry.details,
				entry.timestamp,
				entry.attribution,
			);

		case "branch_summary":
			return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);

		case "compaction":
			return createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp, entry.shortSummary);

		case "thinking_level_change":
		case "model_change":
		case "custom":
		case "label":
		case "service_tier_change":
		case "ttsr_injection":
		case "mcp_tool_selection":
		case "session_init":
		case "mode_change":
			return undefined;
	}
}

type ObfuscateProviderText = (text: string) => string;

const PROVIDER_TEXT_TRANSFORM_ERROR = "Branch summary provider text transformation failed.";

function providerTextTransformError(): Error {
	return new Error(PROVIDER_TEXT_TRANSFORM_ERROR);
}

const MAX_PROVIDER_TRANSFORM_DEPTH = 64;
const MAX_PROVIDER_TRANSFORM_NODES = 100_000;
const MAX_PROVIDER_TRANSFORM_KEYS = 100_000;
const MAX_PROVIDER_TRANSFORM_STRING_CHARS = 16 * 1024 * 1024;

const PROVIDER_PROTOCOL_STRING_FIELDS: Record<string, true> = {
	api: true,
	call_id: true,
	callId: true,
	customWireName: true,
	detail: true,
	finish_reason: true,
	finishReason: true,
	id: true,
	item_id: true,
	itemId: true,
	mime_type: true,
	mimeType: true,
	model: true,
	name: true,
	provider: true,
	response_id: true,
	responseId: true,
	role: true,
	status: true,
	stop_reason: true,
	stopReason: true,
	tool_call_id: true,
	toolCallId: true,
	toolName: true,
	type: true,
};

const OPAQUE_PROVIDER_STRING_FIELDS: Record<string, true> = {
	data: true,
	encrypted_content: true,
	encryptedContent: true,
	signature: true,
	textSignature: true,
	thinkingSignature: true,
	thoughtSignature: true,
};

const PROVIDER_PROTOCOL_KEYS: Record<string, true> = {
	...PROVIDER_PROTOCOL_STRING_FIELDS,
	...OPAQUE_PROVIDER_STRING_FIELDS,
	anthropic_version: true,
	arguments: true,
	args: true,
	cache_control: true,
	content: true,
	contents: true,
	function: true,
	function_call: true,
	generationConfig: true,
	input: true,
	instructions: true,
	max_completion_tokens: true,
	max_output_tokens: true,
	max_tokens: true,
	messages: true,
	metadata: true,
	parallel_tool_calls: true,
	prompt: true,
	reasoning: true,
	safetySettings: true,
	stream: true,
	system: true,
	system_instruction: true,
	temperature: true,
	text: true,
	thinking: true,
	timestamp: true,
	tool_choice: true,
	tool_config: true,
	tools: true,
	top_p: true,
	usage: true,
};

const TOOL_ARGUMENT_OBJECT_TYPES: Record<string, true> = {
	custom_tool_call: true,
	function_call: true,
	toolCall: true,
	tool_use: true,
};

function isToolArgumentField(parent: object, key: string): boolean {
	if (key === "arguments" || key === "args") return true;
	if (key !== "input") return false;
	const type = Object.getOwnPropertyDescriptor(parent, "type");
	return (
		type !== undefined &&
		"value" in type &&
		typeof type.value === "string" &&
		TOOL_ARGUMENT_OBJECT_TYPES[type.value] === true
	);
}

interface ProviderTransformTraversal {
	ancestors: WeakSet<object>;
	nodes: number;
	keys: number;
	sourceStringChars: number;
	transformedStringChars: number;
}

function transformProviderText(
	text: string,
	transform: ObfuscateProviderText,
	traversal: ProviderTransformTraversal,
): string {
	traversal.sourceStringChars += text.length;
	if (traversal.sourceStringChars > MAX_PROVIDER_TRANSFORM_STRING_CHARS) throw providerTextTransformError();
	try {
		const transformed = transform(text);
		if (typeof transformed !== "string") throw new TypeError("Provider text transform returned a non-string value");
		traversal.transformedStringChars += transformed.length;
		if (traversal.transformedStringChars > MAX_PROVIDER_TRANSFORM_STRING_CHARS) {
			throw providerTextTransformError();
		}
		return transformed;
	} catch {
		throw providerTextTransformError();
	}
}

function transformProviderValue<T>(value: T, transform: ObfuscateProviderText): T {
	const traversal: ProviderTransformTraversal = {
		ancestors: new WeakSet<object>(),
		nodes: 0,
		keys: 0,
		sourceStringChars: 0,
		transformedStringChars: 0,
	};
	try {
		return transformProviderValueBounded(value, transform, traversal, 0);
	} catch {
		throw providerTextTransformError();
	}
}

function transformProviderValueBounded<T>(
	value: T,
	transform: ObfuscateProviderText,
	traversal: ProviderTransformTraversal,
	depth: number,
	protocolShape: boolean = true,
	parentKey?: string,
): T {
	if (depth > MAX_PROVIDER_TRANSFORM_DEPTH) throw providerTextTransformError();
	traversal.nodes += 1;
	if (traversal.nodes > MAX_PROVIDER_TRANSFORM_NODES) throw providerTextTransformError();
	if (typeof value === "string") {
		if (protocolShape && parentKey !== undefined && OPAQUE_PROVIDER_STRING_FIELDS[parentKey] === true) {
			const checked = transformProviderText(value, transform, traversal);
			if (checked !== value) throw providerTextTransformError();
			return value;
		}
		return (
			protocolShape && parentKey !== undefined && PROVIDER_PROTOCOL_STRING_FIELDS[parentKey] === true
				? value
				: transformProviderText(value, transform, traversal)
		) as T;
	}
	if (value === null || typeof value !== "object") return value;

	if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
	if (Object.getOwnPropertySymbols(value).length > 0) throw providerTextTransformError();
	if (traversal.ancestors.has(value)) throw providerTextTransformError();

	traversal.ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_PROVIDER_TRANSFORM_NODES) {
				throw providerTextTransformError();
			}
			const transformed = new Array(value.length);
			for (let index = 0; index < value.length; index += 1) {
				const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
				if (!descriptor) continue;
				if (!("value" in descriptor)) throw providerTextTransformError();
				transformed[index] = transformProviderValueBounded(
					descriptor.value,
					transform,
					traversal,
					depth + 1,
					protocolShape,
					parentKey,
				);
			}
			return transformed as T;
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) throw providerTextTransformError();
		const transformed: Record<string, unknown> = {};
		for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
			if (!("value" in descriptor)) throw providerTextTransformError();
			if (!descriptor.enumerable) continue;
			traversal.keys += 1;
			if (traversal.keys > MAX_PROVIDER_TRANSFORM_KEYS) throw providerTextTransformError();
			const transformedKey =
				protocolShape && PROVIDER_PROTOCOL_KEYS[key] === true
					? key
					: transformProviderText(key, transform, traversal);
			if (Object.hasOwn(transformed, transformedKey)) throw providerTextTransformError();
			Object.defineProperty(transformed, transformedKey, {
				value: transformProviderValueBounded(
					descriptor.value,
					transform,
					traversal,
					depth + 1,
					protocolShape && !isToolArgumentField(value, key),
					key,
				),
				enumerable: true,
				configurable: true,
				writable: true,
			});
		}
		return transformed as T;
	} finally {
		traversal.ancestors.delete(value);
	}
}

function resolveProviderTextTransform(options: GenerateBranchSummaryOptions): ObfuscateProviderText | undefined {
	const resolve = options.resolveObfuscateProviderText;
	if (!resolve) return undefined;
	try {
		const transform = resolve();
		if (typeof transform !== "function")
			throw new TypeError("Provider text transform resolver returned a non-function");
		return transform;
	} catch {
		throw providerTextTransformError();
	}
}

function estimateBranchSummaryTokens(message: AgentMessage): number {
	if (message.role !== "toolResult") return estimateTokens(message);
	const text = message.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("");
	if (!text) return 0;
	return estimateTokens({
		...message,
		content: [{ type: "text", text: truncateToolResultForSummary(text) }],
	});
}

function prepareBranchEntriesForProvider(
	entries: SessionEntry[],
	tokenBudget: number,
	transform?: ObfuscateProviderText,
): BranchPreparation {
	const messages: AgentMessage[] = [];
	const fileOps = createFileOps();
	const fileMessages: AgentMessage[] = [];
	let totalTokens = 0;

	for (const entry of entries) {
		if (entry.type === "message") fileMessages.push(entry.message);
		if (entry.type === "branch_summary" && !entry.fromExtension && entry.details) {
			const details = entry.details as BranchSummaryDetails;
			if (Array.isArray(details.readFiles)) {
				for (const f of details.readFiles) fileOps.read.add(stripReadSelector(f));
			}
			if (Array.isArray(details.modifiedFiles)) {
				for (const f of details.modifiedFiles) {
					fileOps.edited.add(f);
				}
			}
		}
	}
	extractFileOpsFromMessages(fileMessages, fileOps);

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const rawMessage = getMessageFromEntry(entry);
		if (!rawMessage) continue;

		const message = transform ? transformProviderValue(rawMessage, transform) : rawMessage;
		const tokens = estimateBranchSummaryTokens(message);

		if (tokenBudget > 0 && totalTokens + tokens > tokenBudget) {
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (totalTokens < tokenBudget * 0.9) {
					messages.unshift(message);
					totalTokens += tokens;
				}
			}
			break;
		}

		messages.unshift(message);
		totalTokens += tokens;
	}

	return { messages, fileOps, totalTokens };
}

export function prepareBranchEntries(entries: SessionEntry[], tokenBudget: number = 0): BranchPreparation {
	return prepareBranchEntriesForProvider(entries, tokenBudget);
}

const BRANCH_SUMMARY_PREAMBLE = prompt.render(AGENT_PROMPTS["compaction/branch-summary-preamble"].text);

const BRANCH_SUMMARY_PROMPT = prompt.render(AGENT_PROMPTS["compaction/branch-summary"].text);

export async function generateBranchSummary(
	entries: SessionEntry[],
	options: GenerateBranchSummaryOptions,
): Promise<BranchSummaryResult> {
	const { model, apiKey, signal, reserveTokens = 16384, metadata } = options;

	const contextWindow = model.contextWindow || 128000;
	const configuredBudget = contextWindow - reserveTokens;
	const tokenBudget = configuredBudget > 0 ? configuredBudget : Math.max(1, Math.floor(contextWindow * 0.85));

	if (prepareBranchEntries(entries, tokenBudget).messages.length === 0) {
		return { summary: "No content to summarize" };
	}

	const context: Context = { messages: [] };
	let activeTransform: ObfuscateProviderText | undefined;
	let fileOps = createFileOps();

	const rebuildAttemptContext = (): void => {
		const transform = resolveProviderTextTransform(options);
		const preparation = prepareBranchEntriesForProvider(entries, tokenBudget, transform);
		const llmMessages = (options.convertToLlm ?? defaultConvertToLlm)(preparation.messages);
		const conversationText = serializeConversationForSummary(llmMessages, preferredDialect(model.id));
		const rawInstructions = options.customInstructions || BRANCH_SUMMARY_PROMPT;
		const instructions = transform ? transformProviderValue(rawInstructions, transform) : rawInstructions;
		const promptText = `<conversation>\n${conversationText}\n</conversation>\n\n${instructions}`;
		const summarizationMessages = [
			{
				role: "user" as const,
				content: [{ type: "text" as const, text: promptText }],
				timestamp: Date.now(),
			},
		];

		context.systemPrompt = [SUMMARIZATION_SYSTEM_PROMPT];
		context.messages = summarizationMessages;
		fileOps = preparation.fileOps;
		activeTransform = transform;
	};

	const attemptApiKey: ApiKey =
		typeof apiKey === "function"
			? async resolveContext => {
					const resolved = await apiKey(resolveContext);
					if (resolved) rebuildAttemptContext();
					return resolved;
				}
			: apiKey;

	if (typeof apiKey !== "function") rebuildAttemptContext();

	let onPayload = options.onPayload;
	if (options.resolveObfuscateProviderText) {
		onPayload = async (payload, payloadModel) => {
			const replacement = await options.onPayload?.(payload, payloadModel);
			const shapedPayload = replacement === undefined ? payload : replacement;
			if (!activeTransform) throw providerTextTransformError();
			return transformProviderValue(shapedPayload, activeTransform);
		};
	}

	const response = await instrumentedCompleteSimple(
		model,
		context,
		{
			apiKey: attemptApiKey,
			signal,
			maxTokens: 2048,
			metadata,
			serviceTier: options.serviceTier,
			sessionId: options.sessionId,
			conversationId: options.conversationId,
			promptCacheKey: options.promptCacheKey,
			onPayload,
		},
		{ telemetry: options.telemetry, oneshotKind: "branch_summary", completeImpl: options.completeImpl },
	);

	if (response.stopReason === "aborted") {
		return { aborted: true };
	}
	if (response.stopReason === "error") {
		return { error: response.errorMessage || "Summarization failed" };
	}

	const generatedSummary = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
		.map(c => c.text)
		.join("\n");

	const degeneracy = detectDegenerateRepetition(generatedSummary);
	if (degeneracy) {
		logger.warn("Branch summary discarded as degenerate", { model: model.id, degeneracy });
	}
	let summary =
		generatedSummary.trim().length > 0 && !degeneracy
			? BRANCH_SUMMARY_PREAMBLE + generatedSummary
			: "No summary generated";

	const { readFiles, modifiedFiles } = computeFileLists(fileOps);
	summary = upsertFileOperations(summary, readFiles, modifiedFiles, fileOps.read);

	return {
		summary: summary || "No summary generated",
		readFiles,
		modifiedFiles,
	};
}
