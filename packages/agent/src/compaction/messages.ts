import type {
	DeveloperMessage,
	ImageContent,
	Message,
	MessageAttribution,
	ProviderPayload,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@veyyon/ai";
import * as prompt from "@veyyon/utils/prompt";
import { AGENT_PROMPTS } from "../prompts/registry";
import type { AgentMessage } from "../types";

const COMPACTION_SUMMARY_TEMPLATE = AGENT_PROMPTS["compaction/compaction-summary-context"].text;
const BRANCH_SUMMARY_TEMPLATE = AGENT_PROMPTS["compaction/branch-summary-context"].text;
const SUMMARY_PRESENTATION_TAG = /<\/?summary\b(?:\s[^>]*)?>/gi;

function withoutSummaryPresentationTags(summary: string): string {
	const text = summary.trim();
	SUMMARY_PRESENTATION_TAG.lastIndex = 0;
	const firstTag = SUMMARY_PRESENTATION_TAG.exec(text);
	if (firstTag?.index !== 0 || firstTag[0].startsWith("</") || /\/\s*>$/.test(firstTag[0])) {
		return text;
	}

	SUMMARY_PRESENTATION_TAG.lastIndex = 0;
	let depth = 0;
	for (let tag = SUMMARY_PRESENTATION_TAG.exec(text); tag; tag = SUMMARY_PRESENTATION_TAG.exec(text)) {
		if (tag[0].startsWith("</")) {
			depth -= 1;
			if (depth !== 0) continue;
			const tagEnd = tag.index + tag[0].length;
			return tagEnd === text.length ? text.slice(firstTag[0].length, tag.index).trim() : text;
		}
		if (!/\/\s*>$/.test(tag[0])) depth += 1;
	}

	return text;
}

export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/** Legacy hook message type (pre-extensions). Kept for session migration. */
export interface HookMessage<T = unknown> extends Omit<CustomMessage<T>, "role"> {
	role: "hookMessage";
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	providerPayload?: ProviderPayload;
	/**
	 * Attribution when the provider compacted server-side, e.g.
	 * `openai/gpt-5.6-sol`. Set from the entry's remote-compaction data at
	 * rebuild; the divider shows it so the operator is never left believing a
	 * configured local compaction model did a compaction the provider did.
	 */
	compactedBy?: string;
	/** Legacy runtime-only archive blocks from the removed image-archive engine:
	 *  old text region, imaged middle, then new text region. Never written by new
	 *  sessions; retained so old persisted summaries still deserialize and count. */
	blocks?: (TextContent | ImageContent)[];
	/** Legacy image-archive blocks, kept for display counts / old-session consumers. */
	images?: ImageContent[];
	/** Post-pass dead-end warning attached to this compaction (progress guard). */
	warning?: string;
	timestamp: number;
}

export type CoreCompactionMessage = CustomMessage | HookMessage | BranchSummaryMessage | CompactionSummaryMessage;

declare module "@veyyon/session" {
	interface CustomAgentMessages {
		custom: CustomMessage;
		hookMessage: HookMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}
export type ConvertToLlm = (messages: AgentMessage[]) => Message[];

function getPrunedToolResultContent(message: ToolResultMessage): (TextContent | ImageContent)[] {
	if (message.prunedAt === undefined) {
		return message.content;
	}
	const textBlocks = message.content.filter((content): content is TextContent => content.type === "text");
	const text = textBlocks.map(block => block.text).join("") || "[Output truncated]";
	return [{ type: "text", text }];
}

export function renderBranchSummaryContext(summary: string): string {
	return prompt.render(BRANCH_SUMMARY_TEMPLATE, { summary: withoutSummaryPresentationTags(summary) });
}

export function renderCompactionSummaryContext(summary: string): string {
	return prompt.render(COMPACTION_SUMMARY_TEMPLATE, { summary: withoutSummaryPresentationTags(summary) });
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	shortSummary?: string,
	providerPayload?: ProviderPayload,
	images?: ImageContent[],
	blocks?: (TextContent | ImageContent)[],
	warning?: string,
	compactedBy?: string,
): CompactionSummaryMessage {
	const imageBlocks =
		blocks?.filter((block): block is ImageContent => block.type === "image") ??
		(images && images.length > 0 ? images : undefined);
	return {
		role: "compactionSummary",
		summary,
		shortSummary,
		tokensBefore,
		providerPayload,
		blocks: blocks && blocks.length > 0 ? blocks : undefined,
		images: imageBlocks && imageBlocks.length > 0 ? imageBlocks : undefined,
		warning,
		compactedBy,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
	attribution?: MessageAttribution,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		attribution,
		timestamp: new Date(timestamp).getTime(),
	};
}

function isCoreCompactionMessage(message: AgentMessage): message is AgentMessage & CoreCompactionMessage {
	return (
		message.role === "custom" ||
		message.role === "hookMessage" ||
		message.role === "branchSummary" ||
		message.role === "compactionSummary"
	);
}

/** A user, developer, custom or hook message: its conversion depends on its role, attribution and content. */
type AuthoredMessage = UserMessage | DeveloperMessage | CustomMessage | HookMessage;

interface CachedConvertedAuthoredMessage {
	role: AuthoredMessage["role"];
	converted: Message;
	attribution: MessageAttribution | undefined;
	content: unknown;
}

interface CachedConvertedToolResultMessage {
	role: "toolResult";
	converted: Message;
	attribution: MessageAttribution | undefined;
	content: unknown;
	prunedAt: number | undefined;
	isError: boolean | undefined;
	toolCallId: string;
}

interface CachedConvertedBranchSummaryMessage {
	role: "branchSummary";
	converted: Message;
	summary: string;
}

interface CachedConvertedCompactionSummaryMessage {
	role: "compactionSummary";
	converted: Message;
	summary: string;
	blocks: unknown;
	images: unknown;
	providerPayload: unknown;
}

type CachedConvertedMessage =
	| CachedConvertedAuthoredMessage
	| CachedConvertedToolResultMessage
	| CachedConvertedBranchSummaryMessage
	| CachedConvertedCompactionSummaryMessage;

const convertedMessageCache = new WeakMap<AgentMessage, CachedConvertedMessage>();

/**
 * Transform a single core-domain agent message to its LLM form; `undefined`
 * drops it from the provider request.
 *
 * Single source of truth for the core roles (user/developer/assistant/
 * toolResult) and the compaction messages owned by this package. Embedders
 * with their own app messages (e.g. the coding agent) handle their custom
 * roles and delegate every core role here — duplicating these cases is how
 * compaction-summary image blocks once silently fell off the provider request.
 */
export function convertMessageToLlm(message: AgentMessage): Message | undefined {
	if (isCoreCompactionMessage(message)) return convertCompactionMessage(message);
	switch (message.role) {
		case "user":
			return (
				cachedAuthoredConversion(message) ??
				cacheAuthoredConversion(message, { ...message, attribution: message.attribution ?? "user" })
			);
		case "developer":
			return (
				cachedAuthoredConversion(message) ??
				cacheAuthoredConversion(message, { ...message, attribution: message.attribution ?? "agent" })
			);
		case "assistant":
			return message;
		case "toolResult":
			return convertToolResultMessage(message as ToolResultMessage);
		default:
			return undefined;
	}
}

function convertCompactionMessage(message: CoreCompactionMessage): Message {
	switch (message.role) {
		case "custom":
		case "hookMessage":
			return (
				cachedAuthoredConversion(message) ??
				cacheAuthoredConversion(message, {
					role: "developer",
					content:
						typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content,
					attribution: message.attribution,
					timestamp: message.timestamp,
				})
			);
		case "branchSummary":
			return convertBranchSummaryMessage(message);
		case "compactionSummary":
			return convertCompactionSummaryMessage(message);
	}
}

/** The cached conversion of `message`, when its role, attribution and content are those it was converted from. */
function cachedAuthoredConversion(message: AuthoredMessage): Message | undefined {
	const cached = convertedMessageCache.get(message);
	if (cached === undefined || !("attribution" in cached)) return undefined;
	return cached.role === message.role &&
		cached.attribution === message.attribution &&
		cached.content === message.content
		? cached.converted
		: undefined;
}

/** Record `converted` as the conversion of `message`'s current role, attribution and content, and return it. */
function cacheAuthoredConversion(message: AuthoredMessage, converted: Message): Message {
	convertedMessageCache.set(message, {
		role: message.role,
		converted,
		attribution: message.attribution,
		content: message.content,
	});
	return converted;
}

function convertBranchSummaryMessage(message: BranchSummaryMessage): Message {
	const cached = convertedMessageCache.get(message);
	if (cached?.role === "branchSummary" && cached.summary === message.summary) {
		return cached.converted;
	}
	const converted: Message = {
		role: "developer",
		content: [{ type: "text", text: renderBranchSummaryContext(message.summary) }],
		attribution: "agent",
		historyRewriteAt: message.timestamp,
		timestamp: message.timestamp,
	};
	convertedMessageCache.set(message, { role: "branchSummary", converted, summary: message.summary });
	return converted;
}

/**
 * A compaction summary as untrusted user history: the rendered summary, then the legacy archive blocks with their
 * presentation tags stripped, or else the legacy images.
 */
function convertCompactionSummaryMessage(message: CompactionSummaryMessage): Message {
	const cached = convertedMessageCache.get(message);
	if (
		cached?.role === "compactionSummary" &&
		cached.summary === message.summary &&
		cached.blocks === message.blocks &&
		cached.images === message.images &&
		cached.providerPayload === message.providerPayload
	) {
		return cached.converted;
	}
	const header: TextContent = { type: "text", text: renderCompactionSummaryContext(message.summary) };
	const converted: Message = {
		role: "user",
		content:
			message.blocks !== undefined
				? [
						header,
						...message.blocks.map(block =>
							block.type === "text" ? { ...block, text: withoutSummaryPresentationTags(block.text) } : block,
						),
					]
				: [header, ...(message.images ?? [])],
		attribution: "agent",
		historyRewriteAt: message.timestamp,
		providerPayload: message.providerPayload,
		timestamp: message.timestamp,
	};
	convertedMessageCache.set(message, {
		role: "compactionSummary",
		converted,
		summary: message.summary,
		blocks: message.blocks,
		images: message.images,
		providerPayload: message.providerPayload,
	});
	return converted;
}

function convertToolResultMessage(message: ToolResultMessage): Message {
	const cached = convertedMessageCache.get(message);
	if (
		cached?.role === "toolResult" &&
		cached.attribution === message.attribution &&
		cached.content === message.content &&
		cached.prunedAt === message.prunedAt &&
		cached.isError === message.isError &&
		cached.toolCallId === message.toolCallId
	) {
		return cached.converted;
	}
	const converted: Message = {
		...message,
		content: getPrunedToolResultContent(message),
		attribution: message.attribution ?? "agent",
	};
	convertedMessageCache.set(message, {
		role: "toolResult",
		converted,
		attribution: message.attribution,
		content: message.content,
		prunedAt: message.prunedAt,
		isError: message.isError,
		toolCallId: message.toolCallId,
	});
	return converted;
}

/**
 * Default compaction-domain transformer.
 *
 * Embedders with their own app messages should pass a richer transformer through
 * `SummaryOptions.convertToLlm`; this default intentionally preserves only the
 * core LLM roles and the compaction messages owned by this package.
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return messages.map(convertMessageToLlm).filter(message => message !== undefined);
}
