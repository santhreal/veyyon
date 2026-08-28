import type { AgentMessage } from "@veyyon/agent-core";
import {
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	convertMessageToLlm,
} from "@veyyon/agent-core/compaction/messages";
import {
	renderToolBatchLedger,
	TOOL_BATCH_LEDGER_HEADLINE_PREFIX,
	type ToolBatchLedger,
} from "@veyyon/agent-core/tool-batch-ledger";
import type {
	AssistantMessage,
	ImageContent,
	Message,
	MessageAttribution,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";
import { isRecord } from "@veyyon/utils/type-guards";
import { formatExitCodeNotice } from "../exec/exit-notice";
import { ToolAbortError } from "../tools/tool-errors";
import { isBlobRef, isTextBlobRef } from "./blob-store";
import { imageDisplayStateForCall, imageVisibilityNotice, isImageVisibilityNotice } from "./image-visibility";

export {
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "@veyyon/agent-core/compaction/messages";

import type { OutputMeta } from "../tools/output-notice";
import { formatOutputNotice } from "../tools/output-notice";

export const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";
export const LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE = "lsp-late-diagnostic";
export const BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE = "background-tan-dispatch";

export const DEFAULT_CUSTOM_MESSAGE_TYPE = "custom-message";

export type CustomMessageContent = string | (TextContent | ImageContent)[];

export type CustomMessagePayload<T = unknown> =
	| string
	| Partial<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">>;

export type NormalizedCustomMessagePayload<T = unknown> = Pick<
	CustomMessage<T>,
	"customType" | "content" | "display" | "details" | "attribution"
>;

export const INTERRUPTED_THINKING_MESSAGE_TYPE = "interrupted-thinking";

export interface InterruptedThinkingDetails {
	interruptedAt: number;
	provider: AssistantMessage["provider"];
	model: string;
	blockCount: number;
}

export interface DemotedInterruptedThinking {
	reasoning: string;
	strippedContent: AssistantMessage["content"];
	blockCount: number;
}

export function demoteInterruptedThinking(
	message: Pick<AssistantMessage, "content">,
): DemotedInterruptedThinking | undefined {
	const content = message.content;
	let scanEnd = content.length;
	while (scanEnd > 0) {
		const block = content[scanEnd - 1]!;
		if (block.type !== "text" || block.text.trim().length > 0) {
			break;
		}
		scanEnd--;
	}

	let runStart = scanEnd;
	while (runStart > 0) {
		const block = content[runStart - 1]!;
		if (block.type !== "thinking" || block.thinking.trim().length === 0 || block.thinkingSignature) {
			break;
		}
		runStart--;
	}

	const blockCount = scanEnd - runStart;
	if (blockCount === 0) {
		return undefined;
	}

	const reasoningBlocks: string[] = [];
	for (let index = runStart; index < scanEnd; index++) {
		const block = content[index]!;
		if (block.type === "thinking") {
			reasoningBlocks.push(block.thinking.trim());
		}
	}

	return {
		reasoning: reasoningBlocks.join("\n\n"),
		strippedContent: content.slice(0, runStart),
		blockCount,
	};
}

function followedByInterruptedThinking(messages: AgentMessage[], index: number): boolean {
	const next = messages[index + 1];
	return next !== undefined && next.role === "custom" && next.customType === INTERRUPTED_THINKING_MESSAGE_TYPE;
}

const strippedThinkingCache = new WeakMap<AssistantMessage, { sourceContent: unknown; stripped: AssistantMessage }>();

function stripDemotedThinkingForLlm(message: AssistantMessage): AssistantMessage {
	const cached = strippedThinkingCache.get(message);
	if (cached && cached.sourceContent === message.content) {
		return cached.stripped;
	}
	const demoted = demoteInterruptedThinking(message);
	const stripped = demoted ? { ...message, content: demoted.strippedContent } : message;
	strippedThinkingCache.set(message, { sourceContent: message.content, stripped });
	return stripped;
}

export interface BackgroundTanDispatchDetails {
	jobId: string;
	work: string;
	sessionFile: string;
}

export interface SkillPromptDetails {
	name: string;
	path: string;
	args?: string;
	lineCount: number;
	__queueChipText?: string;
}

export const SILENT_ABORT_MARKER = "__veyyon.silent_abort__";

const LEGACY_SILENT_ABORT_MARKER = "__omp.silent_abort__";

export function isSilentAbort(message: Pick<AssistantMessage, "errorId" | "errorMessage">): boolean {
	return (
		AIError.is(message.errorId, AIError.Flag.SilentAbort) ||
		message.errorMessage === SILENT_ABORT_MARKER ||
		message.errorMessage === LEGACY_SILENT_ABORT_MARKER
	);
}

export const USER_INTERRUPT_LABEL = "Interrupted by user";

export function isUserInterruptAbort(message: Pick<AssistantMessage, "errorId" | "errorMessage">): boolean {
	return AIError.is(message.errorId, AIError.Flag.UserInterrupt) || message.errorMessage === USER_INTERRUPT_LABEL;
}

export function shouldRenderAbortReason(message: Pick<AssistantMessage, "errorId" | "errorMessage">): boolean {
	return !isSilentAbort(message) && !isUserInterruptAbort(message);
}

export function isEmptyErrorTurn(message: Pick<AssistantMessage, "stopReason" | "content">): boolean {
	if (message.stopReason !== "error") return false;
	return !message.content.some(block => {
		switch (block.type) {
			case "text":
				return block.text.trim().length > 0;
			case "thinking":
				return block.thinking.trim().length > 0 || (block.thinkingSignature?.trim().length ?? 0) > 0;
			case "redactedThinking":
				return block.data.trim().length > 0;
			case "toolCall":
				return true;
			case "fallback":
				return false;
			default:
				return true;
		}
	});
}

export const GENERIC_ABORT_SENTINEL = "Request was aborted";

export function resolveAbortLabel(
	message: Pick<AssistantMessage, "errorId" | "errorMessage">,
	retryAttempt = 0,
): string {
	const genericAbort =
		AIError.is(message.errorId, AIError.Flag.Abort) ||
		!message.errorMessage ||
		message.errorMessage === GENERIC_ABORT_SENTINEL ||
		message.errorMessage === "Aborted: Cancelled" ||
		isSilentAbort(message);
	if (!genericAbort) {
		return message.errorMessage!;
	}
	if (retryAttempt > 0) {
		return `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`;
	}
	return ToolAbortError.MESSAGE;
}

export function readQueueChipText(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const candidate = (details as { __queueChipText?: unknown }).__queueChipText;
	return typeof candidate === "string" ? candidate : undefined;
}

export const INTERNAL_DETAILS_FIELDS = ["__queueChipText"] as const;

export function stripInternalDetailsFields<T>(details: T | undefined): T | undefined {
	if (details == null || typeof details !== "object") return details;
	const obj = details as Record<string, unknown>;
	let hit = false;
	for (const key of INTERNAL_DETAILS_FIELDS) {
		if (key in obj) {
			hit = true;
			break;
		}
	}
	if (!hit) return details;
	const cleaned: Record<string, unknown> = { ...obj };
	for (const key of INTERNAL_DETAILS_FIELDS) {
		delete cleaned[key];
	}
	return cleaned as T;
}

export function isCustomMessageContent(content: unknown): content is CustomMessageContent {
	return typeof content === "string" || Array.isArray(content);
}

function normalizeCustomMessageContent(content: unknown): CustomMessageContent {
	return isCustomMessageContent(content) ? content : "";
}

function normalizeCustomMessageType(customType: unknown): string {
	return typeof customType === "string" && customType.length > 0 ? customType : DEFAULT_CUSTOM_MESSAGE_TYPE;
}

function normalizeCustomMessageAttribution(attribution: unknown): MessageAttribution {
	return attribution === "user" ? "user" : "agent";
}

function isCustomMessagePayloadObject<T>(
	payload: unknown,
): payload is Partial<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">> {
	return isRecord(payload);
}

export function normalizeCustomMessagePayload<T = unknown>(
	payload: CustomMessagePayload<T> | unknown,
): NormalizedCustomMessagePayload<T> {
	if (typeof payload === "string") {
		return {
			customType: DEFAULT_CUSTOM_MESSAGE_TYPE,
			content: payload,
			display: true,
			attribution: "agent",
		};
	}
	if (!isCustomMessagePayloadObject<T>(payload)) {
		const content = payload === undefined || payload === null ? "" : String(payload);
		return {
			customType: DEFAULT_CUSTOM_MESSAGE_TYPE,
			content,
			display: content.length > 0,
			attribution: "agent",
		};
	}
	return {
		customType: normalizeCustomMessageType(payload.customType),
		content: normalizeCustomMessageContent(payload.content),
		display: typeof payload.display === "boolean" ? payload.display : false,
		details: payload.details,
		attribution: normalizeCustomMessageAttribution(payload.attribution),
	};
}

interface StripContentResult {
	content: (TextContent | ImageContent)[];
	removed: number;
}

function stripImagesFromArrayContent(content: (TextContent | ImageContent)[]): StripContentResult {
	let removed = 0;
	const kept: (TextContent | ImageContent)[] = [];
	for (const part of content) {
		if (part.type === "image") {
			removed++;
		} else {
			kept.push(part);
		}
	}
	if (removed === 0) {
		return { content, removed };
	}
	if (kept.length === 0) {
		kept.push({ type: "text", text: "[image removed]" });
	}
	return { content: kept, removed };
}

export function stripImagesFromMessage(message: AgentMessage): number {
	switch (message.role) {
		case "user":
		case "developer":
		case "custom":
		case "hookMessage": {
			if (typeof message.content === "string") return 0;
			const { content, removed } = stripImagesFromArrayContent(message.content);
			if (removed > 0) {
				(message as { content: typeof content }).content = content;
			}
			return removed;
		}
		case "toolResult": {
			let removed = 0;
			const { content, removed: contentRemoved } = stripImagesFromArrayContent(message.content);
			if (contentRemoved > 0) {
				message.content = content;
				removed += contentRemoved;
			}
			const details = message.details as { images?: unknown } | null | undefined;
			if (details && Array.isArray(details.images)) {
				const original = details.images as unknown[];
				const kept: unknown[] = [];
				for (const candidate of original) {
					const looksLikeImageBlock =
						!!candidate && typeof candidate === "object" && (candidate as { type?: unknown }).type === "image";
					if (looksLikeImageBlock) {
						removed++;
					} else {
						kept.push(candidate);
					}
				}
				if (kept.length !== original.length) {
					details.images = kept;
				}
			}
			return removed;
		}
		case "fileMention": {
			let removed = 0;
			for (const file of message.files) {
				if (file.image) {
					file.image = undefined;
					removed++;
				}
			}
			return removed;
		}
		default:
			return 0;
	}
}

export function replaceLlmImagesWithText(messages: Message[], placeholder: string): Message[] {
	let out: Message[] | undefined;
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		if (msg.role !== "user" && msg.role !== "developer" && msg.role !== "toolResult") continue;
		const content = msg.content;
		if (!Array.isArray(content) || !content.some(part => part.type === "image")) continue;
		const replaced: (TextContent | ImageContent)[] = [];
		for (const part of content) {
			if (part.type !== "image") {
				if (part.type === "text" && isImageVisibilityNotice(part.text)) continue;
				replaced.push(part);
				continue;
			}
			const prev = replaced[replaced.length - 1];
			if (prev?.type === "text" && prev.text === placeholder) continue;
			replaced.push({ type: "text", text: placeholder });
		}
		if (out === undefined) out = messages.slice();
		out[i] = { ...msg, content: replaced } as Message;
	}
	return out ?? messages;
}

const LOST_TEXT_PAYLOAD_TEXT =
	"[content unavailable: this text was stored outside the transcript and the stored copy is missing]";

const LOST_IMAGE_PAYLOAD_TEXT =
	"[image unavailable: the image was stored outside the transcript and the stored copy is missing]";

function holdsLostBlobRef(value: unknown): boolean {
	if (typeof value === "string") return isBlobRef(value) || isTextBlobRef(value);
	if (Array.isArray(value)) return value.some(holdsLostBlobRef);
	if (typeof value !== "object" || value === null) return false;
	return Object.values(value).some(holdsLostBlobRef);
}

export function replaceLostBlobPayloads(messages: Message[]): Message[] {
	let out: Message[] | undefined;
	for (let i = 0; i < messages.length; i++) {
		const msg = messages[i];
		const content = msg.content;
		const payloadLost =
			"providerPayload" in msg && msg.providerPayload !== undefined && holdsLostBlobRef(msg.providerPayload);
		const contentLost =
			Array.isArray(content) &&
			content.some(
				part =>
					(part.type === "image" && isBlobRef(part.data)) || (part.type === "text" && isTextBlobRef(part.text)),
			);
		if (!payloadLost && !contentLost) continue;
		let nextContent: unknown = content;
		if (contentLost && Array.isArray(content)) {
			const replaced: unknown[] = [];
			let lastPlaceholder: string | undefined;
			for (const part of content) {
				const placeholder =
					part.type === "image" && isBlobRef(part.data)
						? LOST_IMAGE_PAYLOAD_TEXT
						: part.type === "text" && isTextBlobRef(part.text)
							? LOST_TEXT_PAYLOAD_TEXT
							: undefined;
				if (placeholder === undefined) {
					replaced.push(part);
					lastPlaceholder = undefined;
					continue;
				}
				if (lastPlaceholder === placeholder) continue;
				replaced.push({ type: "text", text: placeholder } satisfies TextContent);
				lastPlaceholder = placeholder;
			}
			nextContent = replaced;
		}
		if (out === undefined) out = messages.slice();
		out[i] = (
			payloadLost ? { ...msg, content: nextContent, providerPayload: undefined } : { ...msg, content: nextContent }
		) as Message;
	}
	return out ?? messages;
}

export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	signal?: number;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;
	excludeFromContext?: boolean;
}

export interface PythonExecutionMessage {
	role: "pythonExecution";
	code: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;
	excludeFromContext?: boolean;
}

export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: CustomMessageContent;
	display: boolean;
	details?: T;
	attribution?: MessageAttribution;
	timestamp: number;
}

export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: CustomMessageContent;
	display: boolean;
	details?: T;
	attribution?: MessageAttribution;
	timestamp: number;
}

export interface FileMentionMessage {
	role: "fileMention";
	files: Array<{
		path: string;
		content: string;
		contentNotReplicated?: boolean;
		lineCount?: number;
		byteSize?: number;
		skippedReason?: "tooLarge" | "binary";
		image?: ImageContent;
	}>;
	timestamp: number;
}

declare module "@veyyon/agent-core" {
	interface CustomAgentMessages {
		bashExecution: BashExecutionMessage;
		pythonExecution: PythonExecutionMessage;
		custom: CustomMessage;
		hookMessage: HookMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
		fileMention: FileMentionMessage;
	}
}

export function bashExecutionToText(msg: BashExecutionMessage): string {
	let text = `Ran \`${msg.command}\`\n`;
	if (msg.output) {
		text += `\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(command cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\n${formatExitCodeNotice(msg.exitCode, msg.signal)}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

export function pythonExecutionToText(msg: PythonExecutionMessage): string {
	let text = `Ran Python:\n\`\`\`python\n${msg.code}\n\`\`\`\n`;
	if (msg.output) {
		text += `Output:\n\`\`\`\n${msg.output}\n\`\`\``;
	} else {
		text += "(no output)";
	}
	if (msg.cancelled) {
		text += "\n\n(execution cancelled)";
	} else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
		text += `\n\nExecution failed with code ${msg.exitCode}`;
	}
	text += formatOutputNotice(msg.meta);
	return text;
}

export function sanitizeRehydratedOpenAIResponsesAssistantMessage(message: AssistantMessage): AssistantMessage {
	if (message.providerPayload?.type !== "openaiResponsesHistory") {
		return message;
	}
	if (message.provider !== "github-copilot") {
		return message;
	}

	let didSanitizeContent = false;
	const sanitizedContent = message.content.map(block => {
		if (block.type !== "thinking" || block.thinkingSignature === undefined) {
			return block;
		}
		didSanitizeContent = true;
		return { ...block, thinkingSignature: undefined };
	});

	return {
		...message,
		...(didSanitizeContent ? { content: sanitizedContent } : {}),
		providerPayload: undefined,
	};
}

function customMessageContentToLlmContent(content: CustomMessage["content"]): (TextContent | ImageContent)[] {
	return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

function isUserInvokedSkillPrompt(message: CustomMessage): boolean {
	return message.customType === SKILL_PROMPT_MESSAGE_TYPE && message.attribution === "user";
}

const imageBearingCustomMessageCache = new WeakMap<
	CustomMessage | HookMessage,
	{ sourceContent: unknown; attribution: MessageAttribution | undefined; customType?: string; converted: Message[] }
>();

function convertImageBearingCustomMessage(message: CustomMessage | HookMessage): Message[] | undefined {
	if (!isCustomMessageContent(message.content)) return undefined;
	if (typeof message.content === "string") return undefined;
	const customType = (message as CustomMessage).customType;
	const cached = imageBearingCustomMessageCache.get(message);
	if (
		cached &&
		cached.sourceContent === message.content &&
		cached.attribution === message.attribution &&
		cached.customType === customType
	) {
		return cached.converted;
	}
	const textBlocks = message.content.filter((content): content is TextContent => content.type === "text");
	const imageBlocks = message.content.filter((content): content is ImageContent => content.type === "image");
	if (imageBlocks.length === 0) return undefined;

	const converted: Message[] = [];
	if (textBlocks.length > 0) {
		converted.push({
			role: "developer",
			content: textBlocks,
			attribution: message.attribution,
			timestamp: message.timestamp,
		});
	}
	converted.push({
		role: "user",
		content: [{ type: "text", text: `Images attached to ${message.customType}.` }, ...imageBlocks],
		attribution: message.attribution,
		timestamp: message.timestamp,
	});
	imageBearingCustomMessageCache.set(message, {
		sourceContent: message.content,
		attribution: message.attribution,
		customType,
		converted,
	});
	return converted;
}

const expiredBatchLedgerCache = new WeakMap<
	ToolResultMessage,
	{ sourceContent: unknown; expired: ToolResultMessage }
>();

function expireAnsweredBatchLedger(
	messages: AgentMessage[],
	index: number,
	message: ToolResultMessage,
): ToolResultMessage {
	const ledger = (message.details as { batchLedger?: ToolBatchLedger } | undefined)?.batchLedger;
	if (ledger === undefined) return message;
	if (!batchAnsweredAfter(messages, index)) return message;
	const cached = expiredBatchLedgerCache.get(message);
	if (cached && cached.sourceContent === message.content) {
		return cached.expired;
	}
	const rendered = renderToolBatchLedger(ledger);
	let changed = false;
	const content = message.content.map(block => {
		if (block.type !== "text") return block;
		const at = block.text.indexOf(rendered);
		if (at < 0) return block;
		changed = true;
		return { ...block, text: block.text.slice(0, at).trimEnd() };
	});
	const expired = changed ? { ...message, content } : message;
	expiredBatchLedgerCache.set(message, { sourceContent: message.content, expired });
	return expired;
}

function batchAnsweredAfter(messages: AgentMessage[], index: number): boolean {
	for (let cursor = index + 1; cursor < messages.length; cursor++) {
		if (messages[cursor]?.role === "assistant") return true;
	}
	return false;
}

function isAnsweredBatchLedgerNotice(messages: AgentMessage[], index: number, message: UserMessage): boolean {
	if (message.synthetic !== true || typeof message.content !== "string") return false;
	if (!message.content.startsWith(TOOL_BATCH_LEDGER_HEADLINE_PREFIX)) return false;
	return batchAnsweredAfter(messages, index);
}

const imageVisibilityCache = new WeakMap<
	ToolResultMessage,
	{ sourceContent: unknown; notice: string | undefined; stamped: ToolResultMessage }
>();

function statePlacedImageVisibility(message: ToolResultMessage): ToolResultMessage {
	const images = message.content.filter(block => block.type === "image").length;
	if (images === 0) return message;
	const notice = imageVisibilityNotice(imageDisplayStateForCall(message.toolCallId, images), images);
	if (!notice) return message;
	const cached = imageVisibilityCache.get(message);
	if (cached && cached.sourceContent === message.content && cached.notice === notice) {
		return cached.stamped;
	}
	const stamped: ToolResultMessage = { ...message, content: message.content.concat([{ type: "text", text: notice }]) };
	imageVisibilityCache.set(message, { sourceContent: message.content, notice, stamped });
	return stamped;
}

interface CachedBashExecution {
	role: "bashExecution";
	converted: Message[];
	command: string;
	output?: string;
	cancelled?: boolean;
	exitCode?: number;
	signal?: number;
	meta?: OutputMeta;
}

interface CachedPythonExecution {
	role: "pythonExecution";
	converted: Message[];
	code: string;
	output?: string;
	cancelled?: boolean;
	exitCode?: number | null;
	meta?: OutputMeta;
}

interface CachedFileMention {
	role: "fileMention";
	converted: Message[];
	files: unknown;
}

interface CachedSkillPrompt {
	role: "skillPrompt";
	converted: Message[];
	content: unknown;
}

type CachedCodingAgentMessage = CachedBashExecution | CachedPythonExecution | CachedFileMention | CachedSkillPrompt;

const codingAgentMessageCache = new WeakMap<AgentMessage, CachedCodingAgentMessage>();

export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.flatMap((m, index): Message[] => {
		switch (m.role) {
			case "bashExecution": {
				if (m.excludeFromContext) {
					return [];
				}
				const cached = codingAgentMessageCache.get(m);
				if (
					cached?.role === "bashExecution" &&
					cached.command === m.command &&
					cached.output === m.output &&
					cached.cancelled === m.cancelled &&
					cached.exitCode === m.exitCode &&
					cached.signal === m.signal &&
					cached.meta === m.meta
				) {
					return cached.converted;
				}
				const converted: Message[] = [
					{
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						attribution: "user",
						timestamp: m.timestamp,
					},
				];
				codingAgentMessageCache.set(m, {
					role: "bashExecution",
					converted,
					command: m.command,
					output: m.output,
					cancelled: m.cancelled,
					exitCode: m.exitCode,
					signal: m.signal,
					meta: m.meta,
				});
				return converted;
			}
			case "pythonExecution": {
				if (m.excludeFromContext) {
					return [];
				}
				const cached = codingAgentMessageCache.get(m);
				if (
					cached?.role === "pythonExecution" &&
					cached.code === m.code &&
					cached.output === m.output &&
					cached.cancelled === m.cancelled &&
					cached.exitCode === m.exitCode &&
					cached.meta === m.meta
				) {
					return cached.converted;
				}
				const converted: Message[] = [
					{
						role: "user",
						content: [{ type: "text", text: pythonExecutionToText(m) }],
						attribution: "user",
						timestamp: m.timestamp,
					},
				];
				codingAgentMessageCache.set(m, {
					role: "pythonExecution",
					converted,
					code: m.code,
					output: m.output,
					cancelled: m.cancelled,
					exitCode: m.exitCode,
					meta: m.meta,
				});
				return converted;
			}
			case "fileMention": {
				const cached = codingAgentMessageCache.get(m);
				if (cached?.role === "fileMention" && cached.files === m.files) {
					return cached.converted;
				}
				const wrap = (file: FileMentionMessage["files"][number]): string => {
					const inner = file.content ? `\n${file.content}\n` : "\n";
					return `<file path="${file.path}">${inner}</file>`;
				};
				const textFiles = m.files.filter(file => !file.image);
				const imageFiles = m.files.filter(file => file.image);
				const out: Message[] = [];
				if (textFiles.length > 0) {
					out.push({
						role: "developer",
						content: [{ type: "text" as const, text: textFiles.map(wrap).join("\n") }],
						attribution: "user",
						timestamp: m.timestamp,
					});
				}
				if (imageFiles.length > 0) {
					const content: (TextContent | ImageContent)[] = [
						{ type: "text" as const, text: imageFiles.map(wrap).join("\n") },
					];
					for (const file of imageFiles) {
						if (file.image) content.push(file.image);
					}
					out.push({
						role: "user",
						content,
						attribution: "user",
						timestamp: m.timestamp,
					});
				}
				codingAgentMessageCache.set(m, {
					role: "fileMention",
					converted: out,
					files: m.files,
				});
				return out;
			}
			case "custom": {
				if (!isCustomMessageContent(m.content)) return [];
				if (isUserInvokedSkillPrompt(m)) {
					const cached = codingAgentMessageCache.get(m);
					if (cached?.role === "skillPrompt" && cached.content === m.content) {
						return cached.converted;
					}
					const converted: Message[] = [
						{
							role: "user",
							content: customMessageContentToLlmContent(m.content),
							attribution: "user",
							timestamp: m.timestamp,
						},
					];
					codingAgentMessageCache.set(m, {
						role: "skillPrompt",
						converted,
						content: m.content,
					});
					return converted;
				}
				const split = convertImageBearingCustomMessage(m);
				if (split) return split;
				const converted = convertMessageToLlm(m);
				return converted ? [converted] : [];
			}
			case "hookMessage": {
				if (!isCustomMessageContent(m.content)) return [];
				const split = convertImageBearingCustomMessage(m);
				if (split) return split;
				const converted = convertMessageToLlm(m);
				return converted ? [converted] : [];
			}
			case "assistant": {
				const source = followedByInterruptedThinking(messages, index) ? stripDemotedThinkingForLlm(m) : m;
				const converted = convertMessageToLlm(source);
				return converted ? [converted] : [];
			}
			case "toolResult": {
				const withVisibility = statePlacedImageVisibility(expireAnsweredBatchLedger(messages, index, m));
				const converted = convertMessageToLlm(withVisibility);
				return converted ? [converted] : [];
			}
			case "user": {
				if (isAnsweredBatchLedgerNotice(messages, index, m)) return [];
				const converted = convertMessageToLlm(m);
				return converted ? [converted] : [];
			}
			case "branchSummary":
			case "compactionSummary":
			case "developer": {
				const converted = convertMessageToLlm(m);
				return converted ? [converted] : [];
			}
			default:
				m satisfies never;
				return [];
		}
	});
}
