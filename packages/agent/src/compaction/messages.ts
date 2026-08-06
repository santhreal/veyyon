import type {
	ImageContent,
	Message,
	MessageAttribution,
	ProviderPayload,
	TextContent,
	ToolResultMessage,
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
export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
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

declare module "../types" {
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
	if (isCoreCompactionMessage(message)) {
		switch (message.role) {
			case "custom":
			case "hookMessage": {
				const content =
					typeof message.content === "string"
						? [{ type: "text" as const, text: message.content }]
						: message.content;
				return {
					role: "developer",
					content,
					attribution: message.attribution,
					timestamp: message.timestamp,
				};
			}
			case "branchSummary":
				return {
					role: "developer",
					content: [
						{
							type: "text" as const,
							text: renderBranchSummaryContext(message.summary),
						},
					],
					attribution: "agent",
					timestamp: message.timestamp,
				};
			case "compactionSummary":
				return {
					role: "user",
					content:
						message.blocks !== undefined
							? [
									{
										type: "text" as const,
										text: renderCompactionSummaryContext(message.summary),
									},
									...message.blocks.map(block =>
										block.type === "text"
											? { ...block, text: withoutSummaryPresentationTags(block.text) }
											: block,
									),
								]
							: [
									{
										type: "text" as const,
										text: renderCompactionSummaryContext(message.summary),
									},
									...(message.images ?? []),
								],
					attribution: "agent",
					providerPayload: message.providerPayload,
					timestamp: message.timestamp,
				};
		}
	}

	switch (message.role) {
		case "user":
			return { ...message, attribution: message.attribution ?? "user" };
		case "developer":
			return { ...message, attribution: message.attribution ?? "agent" };
		case "assistant":
			return message;
		case "toolResult":
			return {
				...message,
				content: getPrunedToolResultContent(message as ToolResultMessage),
				attribution: message.attribution ?? "agent",
			};
		default:
			return undefined;
	}
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
