/**
 * Custom message types and transformers for the coding agent.
 *
 * Extends the base AgentMessage type with coding-agent specific message types,
 * and provides a transformer to convert them to LLM-compatible messages.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import {
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	convertMessageToLlm,
} from "@veyyon/agent-core/compaction/messages";
// Owner, not the `@veyyon/agent-core` barrel: a value import of the barrel drags
// the whole agent runtime and the `@veyyon/utils` barrel into `tools/read`.
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
// Owners, not the `@veyyon/utils` barrel: 1 module against 74.
import { isRecord } from "@veyyon/utils/type-guards";
import { formatExitCodeNotice } from "../exec/exit-notice";
import { ToolAbortError } from "../tools/tool-errors";
import { isBlobRef, isTextBlobRef } from "./blob-store";

export {
	type BranchSummaryMessage,
	type CompactionSummaryMessage,
	createBranchSummaryMessage,
	createCompactionSummaryMessage,
	createCustomMessage,
} from "@veyyon/agent-core/compaction/messages";

// The notice text, not the tool layer that builds it: `../tools/output-meta` reaches 177 modules
// because it owns the builder, the tool wrapper and the spill configuration, and appending a notice to
// a message needs none of them. `../tools/output-notice` owns the wording and the metadata shape.
import type { OutputMeta } from "../tools/output-notice";
import { formatOutputNotice } from "../tools/output-notice";

export const SKILL_PROMPT_MESSAGE_TYPE = "skill-prompt";
export const LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE = "lsp-late-diagnostic";
export const BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE = "background-tan-dispatch";

/** Fallback type for extension-injected messages that omit a custom type. */
export const DEFAULT_CUSTOM_MESSAGE_TYPE = "custom-message";

/** Content shape accepted for extension-injected messages. */
export type CustomMessageContent = string | (TextContent | ImageContent)[];

/** Public input accepted by `pi.sendMessage` and `AgentSession.sendCustomMessage`. */
export type CustomMessagePayload<T = unknown> =
	| string
	| Partial<Pick<CustomMessage<T>, "customType" | "content" | "display" | "details" | "attribution">>;

/** Custom message payload after applying runtime defaults. */
export type NormalizedCustomMessagePayload<T = unknown> = Pick<
	CustomMessage<T>,
	"customType" | "content" | "display" | "details" | "attribution"
>;

/** Custom message type for hidden interrupted-thinking continuity context. */
export const INTERRUPTED_THINKING_MESSAGE_TYPE = "interrupted-thinking";

/** Metadata persisted with a hidden interrupted-thinking continuity message. */
export interface InterruptedThinkingDetails {
	interruptedAt: number;
	provider: AssistantMessage["provider"];
	model: string;
	blockCount: number;
}

/** Pure helper result for persisting interrupted thinking outside the assistant turn. */
export interface DemotedInterruptedThinking {
	reasoning: string;
	strippedContent: AssistantMessage["content"];
	blockCount: number;
}

/**
 * Demote a trailing run of *incomplete* interrupted-thinking from an assistant
 * message — reasoning that was still streaming when the user aborted.
 *
 * A block joins the run only when it is a non-empty `thinking` block with no
 * `thinkingSignature`. A signed/complete thinking block (Anthropic signature,
 * OpenAI reasoning item id) is safely replayable, so it ends the run and stays
 * in place — as do `redactedThinking` encrypted blobs, text, tool calls,
 * empty-thinking blocks, and trailing empty text placeholders.
 */
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

/**
 * True when the assistant turn at `messages[index]` is immediately followed by
 * its hidden `interrupted-thinking` continuity message — the marker that a
 * trailing thinking run was demoted on user interrupt. The run stays on the
 * persisted/displayed assistant message; this flag tells the LLM path to drop it.
 */
function followedByInterruptedThinking(messages: AgentMessage[], index: number): boolean {
	const next = messages[index + 1];
	return next !== undefined && next.role === "custom" && next.customType === INTERRUPTED_THINKING_MESSAGE_TYPE;
}

/**
 * Drop the demoted trailing thinking run from an assistant message for the LLM
 * view only. The run is incomplete and unsigned, so providers reject it; the
 * continuity message that follows carries the reasoning instead.
 */
function stripDemotedThinkingForLlm(message: AssistantMessage): AssistantMessage {
	const demoted = demoteInterruptedThinking(message);
	return demoted ? { ...message, content: demoted.strippedContent } : message;
}

/** Details persisted on a `/tan` background-dispatch breadcrumb. */
export interface BackgroundTanDispatchDetails {
	jobId: string;
	work: string;
	/** Forked clone session file, named `<agentId>.jsonl`; the Control Center reads its transcript. */
	sessionFile: string;
}

export interface SkillPromptDetails {
	name: string;
	path: string;
	args?: string;
	lineCount: number;
	/** Internal: compact label shown for a queued custom message. Optional —
	 *  non-streaming skill prompts never set it. Stripped from persisted
	 *  `details` by `SessionManager.appendCustomMessageEntry` via the
	 *  `INTERNAL_DETAILS_FIELDS` allowlist below. */
	__queueChipText?: string;
}

/** Sentinel value for `AssistantMessage.errorMessage` indicating that the abort
 *  was an *expected internal transition* (plan-mode → execution compaction)
 *  and must NOT surface as a red "Operation aborted" line. Distinct from
 *  `undefined` (default) so user-cancel aborts with no errorMessage still
 *  render normally. Persists through SessionManager so history replay
 *  branches identically.
 *
 *  Consumers: `AgentSession.#handleAgentEvent` (stamper) writes this value;
 *  `EventController.#handleMessageEnd`, `AssistantMessageComponent`,
 *  `ui-helpers.addMessageToChat` (renderers), `AgentDashboard
 *  #buildTranscriptLines`, `runPrintMode`, and `AcpAgent#replayAssistantMessage`
 *  (fallback error emission) read it via `isSilentAbort`. */
export const SILENT_ABORT_MARKER = "__veyyon.silent_abort__";

/** Marker written by pre-fork (oh-my-pi) builds; sessions persisted by them
 *  must still replay their silent aborts silently. Read-only — never stamped. */
const LEGACY_SILENT_ABORT_MARKER = "__omp.silent_abort__";

/** Type-guard for silent aborts. Renderers MUST call this helper so structured
 *  `errorId` and legacy persisted marker messages stay in lockstep. */
export function isSilentAbort(message: Pick<AssistantMessage, "errorId" | "errorMessage">): boolean {
	return (
		AIError.is(message.errorId, AIError.Flag.SilentAbort) ||
		message.errorMessage === SILENT_ABORT_MARKER ||
		message.errorMessage === LEGACY_SILENT_ABORT_MARKER
	);
}

/** Reason threaded through `AbortController.abort(reason)` when the user aborts
 *  the turn with Esc (see `AgentSession.abort`). The agent keeps it on the
 *  aborted assistant message's `errorMessage` so queued follow-ups/tool-result
 *  placeholders can distinguish a deliberate interrupt from a bare lifecycle
 *  abort, but interactive renderers suppress this redundant transcript line. */
export const USER_INTERRUPT_LABEL = "Interrupted by user";

export function isUserInterruptAbort(message: Pick<AssistantMessage, "errorId" | "errorMessage">): boolean {
	return AIError.is(message.errorId, AIError.Flag.UserInterrupt) || message.errorMessage === USER_INTERRUPT_LABEL;
}

export function shouldRenderAbortReason(message: Pick<AssistantMessage, "errorId" | "errorMessage">): boolean {
	return !isSilentAbort(message) && !isUserInterruptAbort(message);
}

/** A provider-rejection turn carrying nothing but the error flag: stopReason
 *  "error" with no text, thinking, or tool calls — e.g. a request the provider
 *  rejected before any output (an oversized 413 payload). Persisting it writes an
 *  empty assistant turn that replays on reload and re-sends the rejected context;
 *  the error is surfaced live (pinned) instead. A turn that streamed partial text,
 *  reasoning, or tool calls is NOT empty and stays in history. */
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
			// Unknown/new block kinds count as content: never silently discard a turn.
			default:
				return true;
		}
	});
}

/** Sentinel `errorMessage` the agent stamps on any abort that carried no custom
 *  reason (bare `abort()`). Renderers treat it as "no specific reason given". */
export const GENERIC_ABORT_SENTINEL = "Request was aborted";

/** Resolve the operator-facing label for an aborted assistant turn. A custom
 *  abort reason threaded onto `errorMessage` is returned verbatim; aborts with
 *  no threaded reason fall back to the retry-aware generic label. Call
 *  `shouldRenderAbortReason` before rendering when user interrupts should stay
 *  visually quiet. */
export function resolveAbortLabel(
	message: Pick<AssistantMessage, "errorId" | "errorMessage">,
	retryAttempt = 0,
): string {
	const genericAbort =
		AIError.is(message.errorId, AIError.Flag.Abort) ||
		!message.errorMessage ||
		message.errorMessage === GENERIC_ABORT_SENTINEL ||
		// AbortError's bare-cancel shape (`Aborted: Cancelled`, utils/abortable.ts)
		// carries no information beyond "aborted"; rendered verbatim it stacked three
		// redundant labels: "Error: Aborted: Cancelled".
		message.errorMessage === "Aborted: Cancelled" ||
		isSilentAbort(message);
	if (!genericAbort) {
		return message.errorMessage!;
	}
	if (retryAttempt > 0) {
		return `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`;
	}
	// The same sentence ToolAbortError falls back to, imported rather than spelled
	// again: the banner and the thrown error must not drift into two wordings for
	// one state.
	return ToolAbortError.MESSAGE;
}

/** Extract the optional `__queueChipText` field from a CustomMessage's
 *  `details` blob. Safe over `unknown`; returns undefined when the field is
 *  absent or non-string. */
export function readQueueChipText(details: unknown): string | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const candidate = (details as { __queueChipText?: unknown }).__queueChipText;
	return typeof candidate === "string" ? candidate : undefined;
}

/** Explicit allowlist of `details` field names that are AgentSession-internal
 *  transient bookkeeping and MUST be removed before SessionManager persists
 *  the CustomMessageEntry to disk. Scoped intentionally narrow: only fields
 *  declared here are stripped. Adding a new entry is a deliberate, reviewed
 *  change — unrelated future payload fields are never silently dropped. */
export const INTERNAL_DETAILS_FIELDS = ["__queueChipText"] as const;

/** Return a `details` copy with every key in `INTERNAL_DETAILS_FIELDS`
 *  removed. Returns the input unchanged when there is nothing to strip
 *  (null/non-object, or no listed fields present) so callers don't pay a
 *  clone cost on the common path. */
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

/** True when a persisted or extension-supplied value can be sent as custom-message content. */
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

/** Normalizes extension-provided custom message input before it reaches session state or disk. */
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

/** Result of filtering image blocks out of a `(TextContent | ImageContent)[]` array. */
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
	// Avoid emitting an empty `content` array — providers reject zero-block user/tool
	// messages and the LLM still needs to see *something* where the image used to be.
	if (kept.length === 0) {
		kept.push({ type: "text", text: "[image removed]" });
	}
	return { content: kept, removed };
}

/**
 * Strip image content blocks from `message` in place. Returns the count of
 * images removed across `content` (every role that carries `ImageContent`) and
 * any tool-result `details.images` payload. Callers MUST rewrite session
 * entries (`SessionManager.rewriteEntries`) and replay them through
 * `Agent.replaceMessages` afterwards so persisted state and provider-side
 * caches stay aligned with the mutated tree — `stripImagesFromMessage` is a
 * pure local mutation and intentionally does neither.
 */
export function stripImagesFromMessage(message: AgentMessage): number {
	switch (message.role) {
		case "user":
		case "developer":
		case "custom":
		case "hookMessage": {
			if (typeof message.content === "string") return 0;
			const { content, removed } = stripImagesFromArrayContent(message.content);
			if (removed > 0) {
				// All four roles type `content` as `string | (TextContent | ImageContent)[]`;
				// TypeScript can't narrow the assignment across the union, so cast once.
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

/**
 * Replace every `ImageContent` block in already-converted LLM {@link Message}s
 * with a text placeholder, returning a new array only when something changed.
 *
 * Unlike {@link stripImagesFromMessage} (which mutates persisted `AgentMessage`s
 * in place), this operates on the ephemeral provider-request view produced by
 * {@link convertToLlm}, so history on disk keeps its images while the outbound
 * request is scrubbed. Its one caller is `applyProviderImagePolicy`, which
 * decides from the model serving the request whether images may travel at all
 * (a text-only model after a mid-session switch, #5400) and whether the
 * operator blocked them outright (`images.blockImages`).
 *
 * Consecutive placeholder texts collapse into one so a message that was nothing
 * but images does not balloon into a run of identical notes.
 */
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

/** Sentence a request carries where an externalized text payload is missing from the blob store. */
const LOST_TEXT_PAYLOAD_TEXT =
	"[content unavailable: this text was stored outside the transcript and the stored copy is missing]";

/** Sentence a request carries where an image's stored bytes are missing from the blob store. */
const LOST_IMAGE_PAYLOAD_TEXT =
	"[image unavailable: the image was stored outside the transcript and the stored copy is missing]";

/**
 * Replace content that is still a blob reference with a sentence saying so.
 *
 * Persistence moves a large text block or an image out of the JSONL line and leaves
 * a `blobtext:sha256:…` / `blob:sha256:…` reference in its place, and the load path
 * puts the bytes back. When the blob is gone (a `veyyon gc --blobs --apply` whose
 * reference scan never saw this transcript, a home directory restored without its
 * blobs, a transcript copied off another machine or another `--agent-dir`) the load
 * keeps the reference rather than guessing, so the payload comes back the moment the
 * directory does. What must NOT happen is shipping that reference as content: an
 * image block whose `data` is a hash is not base64, so the provider rejects the whole
 * request and every later turn of that session dies the same way, and a text block
 * whose text is a hash tells the model a hash where its own earlier output was.
 *
 * So the request carries the loss and the transcript keeps the reference, which is
 * the same split {@link replaceLlmImagesWithText} makes for the image policy. Every
 * role is covered, because an assistant text block is externalized like any other.
 * Consecutive placeholders collapse, so a message that was nothing but lost images is
 * one sentence rather than a run of identical ones.
 *
 * A reference can also survive inside `providerPayload`, the transport-native history
 * a Responses-style provider replays, where an image lives at an `image_url` key that
 * no sentence can stand in for. Replay is an optimization over the converted messages,
 * so a payload holding a lost reference is dropped and the request falls back to the
 * ordinary conversion, which carries the sentence.
 *
 * NOT covered: a reference embedded inside a longer string. Externalization replaces
 * a whole string value, so that shape is not something this system produces, and
 * rewriting a substring would edit a message that merely quotes a reference.
 */
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
		// Blocks of every role pass through, and an assistant message carries kinds a
		// user message never does (thinking, tool calls), so the rebuilt list is typed
		// by what it holds rather than by the two kinds this function creates.
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

/**
 * Message type for bash executions via the ! command.
 */
export interface BashExecutionMessage {
	role: "bashExecution";
	command: string;
	output: string;
	exitCode: number | undefined;
	/**
	 * The signal that killed the command, when it died from one.
	 *
	 * A `!` command is run through the same executor as the agent's bash tool, so
	 * it inherits the same ambiguity: `exitCode` 137 is produced both by an
	 * out-of-memory kill and by a program calling `exit(137)`. Optional because
	 * sessions recorded before this field existed do not have it, and its absence
	 * means "not known", not "not a signal".
	 */
	signal?: number;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;
	/** If true, this message is excluded from LLM context (!! prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for user-initiated Python executions via the $ command.
 * Shares the same kernel session as eval's Python backend.
 */
export interface PythonExecutionMessage {
	role: "pythonExecution";
	code: string;
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	meta?: OutputMeta;
	timestamp: number;
	/** If true, this message is excluded from LLM context ($$ prefix) */
	excludeFromContext?: boolean;
}

/**
 * Message type for extension-injected messages via sendMessage().
 */
export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: CustomMessageContent;
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/**
 * Legacy hook message type (pre-extensions). Kept for session migration.
 */
export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: CustomMessageContent;
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/**
 * Message type for auto-read file mentions via @filepath syntax.
 */
export interface FileMentionMessage {
	role: "fileMention";
	files: Array<{
		path: string;
		content: string;
		/**
		 * Set on a collab GUEST's replica, where the body was deliberately not sent: a mention's full
		 * text is never drawn, so shipping it would put every mentioned file on every viewer's disk.
		 * Distinct from an empty `content`, which means the file really was empty — the difference is
		 * what stops an export printing a blank `<file>` block as though it had read one.
		 */
		contentNotReplicated?: boolean;
		lineCount?: number;
		/** File size in bytes, if known. */
		byteSize?: number;
		/** Why the file contents were omitted from auto-read. */
		skippedReason?: "tooLarge" | "binary";
		image?: ImageContent;
	}>;
	timestamp: number;
}

// Extend CustomAgentMessages via declaration merging
// Legacy hookMessage is kept for migration; new code should use custom.
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

/**
 * Convert a BashExecutionMessage to user message text for LLM context.
 */
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

/**
 * Convert a PythonExecutionMessage to user message text for LLM context.
 */
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
	// Only GitHub Copilot rejects replayed assistant-side native history on a
	// warmed (resumed) session with HTTP 401 — that is the sole reason this strip
	// exists. For every other Responses-family provider (OpenAI, OpenAI-Codex,
	// Azure) the encrypted reasoning and native response items are self-contained
	// and MUST survive rehydration: remote compaction replays them to rebuild
	// faithful native history (user + assistant turns + encrypted reasoning), and
	// same-model live turns reuse them for prompt-cache continuity. Stripping them
	// for all providers is what left resumed sessions compacting tool-call-only
	// history with no reasoning and no assistant prose.
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

	// Strip the assistant-side native replay payload entirely. After rehydration
	// it belongs to a previous live Copilot connection and replaying it on a
	// warmed session causes 401 rejections. User/developer payloads are preserved
	// separately by the caller.
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

function convertImageBearingCustomMessage(message: CustomMessage | HookMessage): Message[] | undefined {
	if (!isCustomMessageContent(message.content)) return undefined;
	if (typeof message.content === "string") return undefined;
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
	return converted;
}

/**
 * Retire a batch ledger the model has already answered.
 *
 * The ledger is a standing INSTRUCTION ("only the calls marked never ran need
 * retrying"), attached to one placeholder result per cut-short batch so the
 * model can pick the batch back up. It has an expiry the text cannot express:
 * once an assistant turn has responded to that batch, the instruction has been
 * carried out, and every later request re-sent it anyway. On the reported
 * 75-call batch that is twenty-nine lines and about two thousand characters of
 * orders about calls the model already reissued, on every request for the rest
 * of the session and again after a resume, telling it to redo work whose
 * results are sitting right there.
 *
 * A retried turn does not reach this: the whole dead turn and its placeholders
 * are dropped from the context (session-context.ts, `retryRecovery`). A turn
 * the session CONTINUED instead of replaying stays in history on purpose,
 * because the continuation answered from it, so the ledger it carries needs an
 * expiry rather than a deletion.
 *
 * The stored result is untouched: the transcript still renders the full ledger,
 * and the details it renders from (`batchLedger`) are what this reads.
 */
function expireAnsweredBatchLedger(
	messages: AgentMessage[],
	index: number,
	message: ToolResultMessage,
): ToolResultMessage {
	const ledger = (message.details as { batchLedger?: ToolBatchLedger } | undefined)?.batchLedger;
	if (ledger === undefined) return message;
	if (!batchAnsweredAfter(messages, index)) return message;
	// Rendered by the ONE owner, so the slice cannot drift from what was written.
	const rendered = renderToolBatchLedger(ledger);
	let changed = false;
	const content = message.content.map(block => {
		if (block.type !== "text") return block;
		const at = block.text.indexOf(rendered);
		if (at < 0) return block;
		changed = true;
		return { ...block, text: block.text.slice(0, at).trimEnd() };
	});
	return changed ? { ...message, content } : message;
}

/** Has an assistant turn responded to the batch this message belongs to. */
function batchAnsweredAfter(messages: AgentMessage[], index: number): boolean {
	for (let cursor = index + 1; cursor < messages.length; cursor++) {
		if (messages[cursor]?.role === "assistant") return true;
	}
	return false;
}

/**
 * The turn-level form of the same instruction, and the same expiry.
 *
 * When a cut-short batch leaves no placeholder result to attach the ledger to
 * (every call was exec-resolved out of band, or its arguments never finished),
 * the agent loop sends the whole ledger as a synthetic user message instead.
 * That form stores no ledger data, so it is recognized by the headline its own
 * renderer writes, and the whole message is dropped rather than sliced, because
 * the message IS the ledger and nothing else.
 *
 * It is dropped from the outbound request only. The transcript keeps it, which
 * is what renders the reason the batch went quiet.
 */
function isAnsweredBatchLedgerNotice(messages: AgentMessage[], index: number, message: UserMessage): boolean {
	if (message.synthetic !== true || typeof message.content !== "string") return false;
	if (!message.content.startsWith(TOOL_BATCH_LEDGER_HEADLINE_PREFIX)) return false;
	return batchAnsweredAfter(messages, index);
}

/**
 * Transform AgentMessages (including custom types) to LLM-compatible Messages.
 *
 * This is used by:
 * - Agent's transormToLlm option (for prompt calls and queued messages)
 * - Compaction's generateSummary (for summarization)
 * - Custom extensions and tools
 */
export function convertToLlm(messages: AgentMessage[]): Message[] {
	return messages.flatMap((m, index): Message[] => {
		switch (m.role) {
			case "bashExecution":
				if (m.excludeFromContext) {
					return [];
				}
				return [
					{
						role: "user",
						content: [{ type: "text", text: bashExecutionToText(m) }],
						attribution: "user",
						timestamp: m.timestamp,
					},
				];
			case "pythonExecution":
				if (m.excludeFromContext) {
					return [];
				}
				return [
					{
						role: "user",
						content: [{ type: "text", text: pythonExecutionToText(m) }],
						attribution: "user",
						timestamp: m.timestamp,
					},
				];
			case "fileMention": {
				// One `fileMention` can mix `@notes.md` (text) and `@screenshot.png` (image)
				// in the same turn (`generateFileMentionMessages` packs every `@…` into a
				// single message). Splitting by image presence keeps text-only mentions on
				// the higher-priority `developer` slot while routing image attachments
				// through `user`, the only Responses content slot that legitimately accepts
				// `input_image` (Codex chatgpt.com /codex/responses rejects everything else
				// with `Invalid value: 'input_image'`, #3443).
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
				return out;
			}
			case "custom": {
				if (!isCustomMessageContent(m.content)) return [];
				if (isUserInvokedSkillPrompt(m)) {
					return [
						{
							role: "user",
							content: customMessageContentToLlmContent(m.content),
							attribution: "user",
							timestamp: m.timestamp,
						},
					];
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
				// A user-interrupted turn keeps its trailing thinking run on the
				// persisted/displayed message so reload and Ctrl+L rebuilds still
				// show it. That run is incomplete/unsigned and gets rejected on
				// resend, so strip it here — LLM path only — when the hidden
				// interrupted-thinking continuity message follows.
				const source = followedByInterruptedThinking(messages, index) ? stripDemotedThinkingForLlm(m) : m;
				const converted = convertMessageToLlm(source);
				return converted ? [converted] : [];
			}
			case "toolResult": {
				// Core roles share one transformer with agent-core, but this one carries
				// a standing instruction with an expiry, so it is spelled out.
				const converted = convertMessageToLlm(expireAnsweredBatchLedger(messages, index, m));
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
				// Core roles share one transformer with agent-core —
				// duplicating them here is how compaction-summary image blocks
				// once silently fell off the provider request.
				const converted = convertMessageToLlm(m);
				return converted ? [converted] : [];
			}
			default:
				m satisfies never;
				return [];
		}
	});
}
