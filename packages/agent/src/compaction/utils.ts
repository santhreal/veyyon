/**
 * Shared utilities for compaction and branch summarization.
 */

import type { Message, ToolCall } from "@veyyon/ai";
import type { Dialect } from "@veyyon/ai/dialect";
// The factory declares it; the dialect barrel re-exports every definition alongside it.
import { getDialectDefinition } from "@veyyon/ai/dialect/factory";
import {
	containsUrlScheme,
	formatGroupedPaths,
	prompt,
	splitReadSelector,
	stringifyJson,
	stripReadSelector,
} from "@veyyon/utils";
import { AGENT_PROMPTS } from "../prompts/registry";
import type { AgentMessage } from "../types";

// ============================================================================
// File Operation Tracking
// ============================================================================

export interface FileOperations {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

export function createFileOps(): FileOperations {
	return {
		read: new Set(),
		written: new Set(),
		edited: new Set(),
	};
}

// The read-tool selector grammar + splitter live in @veyyon/utils
// (read-selector.ts), the single owner shared with the coding-agent read tool's
// `splitPathAndSel`. Re-exported here so existing compaction callers
// (`stripReadSelector` for the file-operations list, `readToolSupersedeKey`
// keying on both parts) keep their import site unchanged.
export { splitReadSelector, stripReadSelector };

/**
 * Whether `path` references a `scheme://` URL (internal URI or web URL) rather
 * than a filesystem path that belongs in the compaction `<files>` summary.
 *
 * A real filesystem path never contains a `scheme://` URL. Tool-call paths that
 * do — `conflict://1`, `artifact://3`, `local://ctx.md`, `history://…`,
 * `issue://12`, `https://…`, and the tolerated `file.ts:conflict://1` prefix
 * form — are session-scoped or remote resources, not files the post-compaction
 * agent can re-ground on. Keep them out of the `<files>` summary. Matches a
 * scheme anywhere (not only at the start) so the tolerated prefix form counts.
 */
export function isUrlSchemePath(path: string): boolean {
	return containsUrlScheme(path);
}

/**
 * Extract file operations from tool calls in an assistant message.
 */
export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return;
	for (const block of message.content) {
		if (block.type !== "toolCall" || block.name !== "read") continue;
		const args = block.arguments as Record<string, unknown> | undefined;
		const path = typeof args?.path === "string" ? args.path : undefined;
		if (path && !isUrlSchemePath(path)) fileOps.read.add(stripReadSelector(path));
	}
}

/**
 * The files one completed tool result actually mutated, and how.
 *
 * The ONE owner of "which paths did this tool change", because two callers need the
 * same answer from opposite directions: compaction replays a finished transcript to
 * build its `<files>` list, and the live session counts uncommitted drift as the edits
 * happen. Deriving it twice would let a tool be added to one reader and missed by the
 * other, and the reader that missed it would fail silently — a shorter list, never an
 * error.
 *
 * Reads the RESULT details rather than the call arguments, so it reports what the tool
 * did rather than what it was asked to do: `edit` writes several files from one `input`
 * payload with no `path` argument at all, and `ast_edit` reports zero paths when it
 * matched nothing. Returns `null` when the tool mutates nothing.
 */
export function mutatedPathsFromToolResult(
	toolName: string,
	detailsValue: unknown,
): { kind: "written" | "edited"; paths: string[] } | null {
	if (!detailsValue || typeof detailsValue !== "object") return null;
	let details = detailsValue as Record<string, unknown>;
	let effectiveTool = toolName;
	if (toolName === "resolve" && details.action === "apply" && details.sourceToolName === "ast_edit") {
		effectiveTool = "ast_edit";
		if (!details.sourceResultDetails || typeof details.sourceResultDetails !== "object") return null;
		details = details.sourceResultDetails as Record<string, unknown>;
	}

	let candidates: unknown[] = [];
	if (effectiveTool === "write") {
		candidates = [details.resolvedPath];
	} else if (effectiveTool === "edit") {
		const perFileResults = Array.isArray(details.perFileResults) ? details.perFileResults : [];
		candidates = [
			details.path,
			details.sourcePath,
			...perFileResults.flatMap(value => {
				if (!value || typeof value !== "object") return [];
				const result = value as Record<string, unknown>;
				return [result.path, result.sourcePath];
			}),
		];
	} else if (
		effectiveTool === "ast_edit" &&
		details.applied === true &&
		typeof details.totalReplacements === "number" &&
		details.totalReplacements > 0
	) {
		candidates = Array.isArray(details.files) ? details.files : [];
	} else {
		return null;
	}

	const paths: string[] = [];
	for (const candidate of candidates) {
		if (typeof candidate !== "string" || candidate.length === 0 || isUrlSchemePath(candidate)) continue;
		paths.push(candidate);
	}
	if (paths.length === 0) return null;
	return { kind: effectiveTool === "write" ? "written" : "edited", paths };
}

/**
 * Extract only completed file operations from a chronological message slice.
 * Read calls remain useful discovery evidence; mutations require a paired,
 * successful tool result and prefer its exact affected-path details.
 */
export function extractFileOpsFromMessages(messages: readonly AgentMessage[], fileOps: FileOperations): void {
	const calls = new Map<string, { name: string; arguments: Record<string, unknown> | undefined }>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			calls.set(block.id, {
				name: block.name,
				arguments:
					block.arguments && typeof block.arguments === "object"
						? (block.arguments as Record<string, unknown>)
						: undefined,
			});
			if (block.name === "read") {
				const path = typeof block.arguments?.path === "string" ? block.arguments.path : undefined;
				if (path && !isUrlSchemePath(path)) fileOps.read.add(stripReadSelector(path));
			}
		}
	}

	for (const message of messages) {
		if (message.role !== "toolResult" || message.isError === true) continue;
		const call = calls.get(message.toolCallId);
		const toolName = message.toolName || call?.name;
		if (!toolName) continue;
		const mutation = mutatedPathsFromToolResult(toolName, message.details);
		if (mutation) {
			const target = mutation.kind === "written" ? fileOps.written : fileOps.edited;
			for (const mutated of mutation.paths) target.add(mutated);
			continue;
		}
		if (toolName !== "write" && toolName !== "edit") continue;
		const path = typeof call?.arguments?.path === "string" ? call.arguments.path : undefined;
		if (!path || isUrlSchemePath(path)) continue;
		(toolName === "write" ? fileOps.written : fileOps.edited).add(path);
	}
}

/**
 * Compute final file lists from file operations.
 * Returns readFiles (files only read, not modified) and modifiedFiles.
 */
export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	// Drop any `scheme://` URLs (e.g. legacy `conflict://`/`artifact://` entries
	// rehydrated straight into `fileOps` from a pre-fix compaction summary) — only
	// real files belong in `<files>`. New tool-call scans are already filtered.
	const modified = new Set([...fileOps.edited, ...fileOps.written].filter(f => !isUrlSchemePath(f)));
	const readOnly = [...fileOps.read].filter(f => !isUrlSchemePath(f) && !modified.has(f)).sort();
	const modifiedFiles = [...modified].sort();
	return { readFiles: readOnly, modifiedFiles };
}

/**
 * Format file operations as one `<files>` tag: a grouped, prefix-folded
 * directory tree (find-tool shape — `# dir/` headers, bare basenames) with a
 * ` (Read)` / ` (Write)` / ` (RW)` marker per file instead of separate
 * read/modified lists. `readSet` is the cumulative read set (`fileOps.read`),
 * used to tell modified files that were also read (RW) from blind writes.
 */
const FILE_OPERATION_SUMMARY_LIMIT = 20;

function stripFileOperationTags(summary: string): string {
	// Legacy <read-files>/<modified-files> tags are still stripped so summaries
	// written before the combined <files> tag self-heal on the next compaction.
	return summary
		.replace(/<files>[\s\S]*?<\/files>\s*/g, "")
		.replace(/<read-files>[\s\S]*?<\/read-files>\s*/g, "")
		.replace(/<modified-files>[\s\S]*?<\/modified-files>\s*/g, "")
		.trimEnd();
}
export function formatFileOperations(
	readFiles: string[],
	modifiedFiles: string[],
	readSet?: ReadonlySet<string>,
): string {
	if (readFiles.length === 0 && modifiedFiles.length === 0) return "";
	const mode = new Map<string, "Read" | "Write" | "RW">();
	for (const file of readFiles) mode.set(file, "Read");
	for (const file of modifiedFiles) mode.set(file, readSet?.has(file) ? "RW" : "Write");
	const all = [...mode.keys()].sort();
	let files = formatGroupedPaths(all.slice(0, FILE_OPERATION_SUMMARY_LIMIT), path => ` (${mode.get(path)})`);
	if (all.length > FILE_OPERATION_SUMMARY_LIMIT) {
		files += `\n[…${all.length - FILE_OPERATION_SUMMARY_LIMIT} files elided…]`;
	}
	return prompt.render(AGENT_PROMPTS["compaction/file-operations"].text, { files });
}

export function upsertFileOperations(
	summary: string,
	readFiles: string[],
	modifiedFiles: string[],
	readSet?: ReadonlySet<string>,
): string {
	const baseSummary = stripFileOperationTags(summary);
	const fileOperations = formatFileOperations(readFiles, modifiedFiles, readSet);
	if (!fileOperations) return baseSummary;
	if (!baseSummary) return fileOperations;
	return `${baseSummary}\n\n${fileOperations}`;
}

// ============================================================================
// Message Serialization
// ============================================================================

/** Maximum characters for a tool result in serialized summaries. */
const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Truncate tool results to the same representation used in summarization prompts.
 */
export function truncateToolResultForSummary(text: string): string {
	if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
	const marker = "\n\n[... middle omitted; tail preserved ...]\n\n";
	const retainedChars = TOOL_RESULT_MAX_CHARS - marker.length;
	const headChars = Math.ceil(retainedChars / 2);
	const tailChars = retainedChars - headChars;
	return `${text.slice(0, headChars)}${marker}${text.slice(text.length - tailChars)}`;
}

type SummaryTextTransform = (text: string) => string;

function transformJsonStringValues(
	value: unknown,
	transform: SummaryTextTransform,
	seen: WeakMap<object, unknown>,
): unknown {
	if (typeof value === "string") return transform(value);
	if (value === null || typeof value !== "object") return value;
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;

	const prior = seen.get(value);
	if (prior !== undefined) return prior;

	if (Array.isArray(value)) {
		const transformed: unknown[] = [];
		seen.set(value, transformed);
		for (const item of value) transformed.push(transformJsonStringValues(item, transform, seen));
		return transformed;
	}

	const transformed: Record<string, unknown> = {};
	seen.set(value, transformed);
	for (const [key, item] of Object.entries(value)) {
		// Tool argument keys are user-authored JSON data, not provider protocol
		// shape. Redact them before JSON serialization, and reject collisions
		// instead of silently overwriting one argument with another.
		const transformedKey = transform(key);
		if (Object.hasOwn(transformed, transformedKey)) {
			throw new Error("Summary text transformation produced colliding tool argument keys");
		}
		Object.defineProperty(transformed, transformedKey, {
			value: transformJsonStringValues(item, transform, seen),
			enumerable: true,
			configurable: true,
			writable: true,
		});
	}
	return transformed;
}

/**
 * Clone summary-bound messages while transforming only provider-visible prose.
 *
 * Roles, content discriminants, tool identifiers/names, statuses, signatures,
 * opaque provider replay payloads, and provider protocol keys stay byte-for-byte
 * intact. Tool argument keys and string values are transformed recursively
 * before serialization, so a secret crossing a JSON-escaping or truncation
 * boundary cannot leave a raw fragment behind.
 */
export function transformMessagesForSummary(messages: Message[], transform: SummaryTextTransform): Message[] {
	return messages.map(message => {
		if (message.role === "user" || message.role === "developer") {
			const content =
				typeof message.content === "string"
					? transform(message.content)
					: message.content.map(block =>
							block.type === "text" ? { ...block, text: transform(block.text) } : block,
						);
			return { ...message, content };
		}

		if (message.role === "assistant") {
			const content = message.content.map(block => {
				if (block.type === "text") return { ...block, text: transform(block.text) };
				if (block.type === "thinking") return { ...block, thinking: transform(block.thinking) };
				if (block.type === "toolCall") {
					return {
						...block,
						arguments: transformJsonStringValues(block.arguments, transform, new WeakMap()) as Record<
							string,
							unknown
						>,
						...(block.intent === undefined ? {} : { intent: transform(block.intent) }),
					};
				}
				return block;
			});
			return { ...message, content };
		}

		return {
			...message,
			content: message.content.map(block =>
				block.type === "text" ? { ...block, text: transform(block.text) } : block,
			),
		};
	});
}

const HARMONY_CONTROL_TOKEN_RE = /<\|(start|end|message|channel|constrain|return|call)\|>/g;

/**
 * Serialize LLM messages as plain summary input without provider control tokens.
 */
export function serializeConversationForSummary(messages: Message[], dialect?: Dialect): string {
	const conversation = serializeConversation(messages, dialect);
	if (dialect !== "harmony") return conversation;
	return conversation.replace(HARMONY_CONTROL_TOKEN_RE, "<\\|$1\\|>");
}

/**
 * Serialize LLM messages to transcript text.
 * Call convertToLlm() first to handle custom message types.
 */
export function serializeConversation(messages: Message[], dialect?: Dialect): string {
	// Tool results flagged contextually useless (and their paired calls) are
	// dropped from the serialized text: the source region is discarded after
	// summarization anyway, so excluding them costs nothing and keeps garbage
	// out of the summary input.
	const uselessCallIds = new Set<string>();
	for (const msg of messages) {
		if (msg.role === "toolResult" && msg.useless === true && msg.isError !== true) {
			uselessCallIds.add(msg.toolCallId);
		}
	}
	if (dialect) {
		const processed: Message[] = [];
		for (const msg of messages) {
			if (msg.role === "assistant") {
				const content = msg.content.filter(block => block.type !== "toolCall" || !uselessCallIds.has(block.id));
				if (content.length > 0) processed.push(content.length === msg.content.length ? msg : { ...msg, content });
				continue;
			}
			if (msg.role === "toolResult") {
				if (uselessCallIds.has(msg.toolCallId)) continue;
				const text = msg.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map(c => c.text)
					.join("");
				if (!text) continue;
				processed.push({
					...msg,
					content: [{ type: "text", text: truncateToolResultForSummary(text) }],
				});
				continue;
			}
			processed.push(msg);
		}
		return getDialectDefinition(dialect).renderTranscript(processed);
	}

	const parts: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const content =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map(c => c.text)
							.join("");
			if (content) parts.push(`[User]: ${content}`);
		} else if (msg.role === "assistant") {
			const textParts: string[] = [];
			const thinkingParts: string[] = [];
			const toolCalls: ToolCall[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					textParts.push(block.text);
				} else if (block.type === "thinking") {
					thinkingParts.push(block.thinking);
				} else if (block.type === "toolCall") {
					if (uselessCallIds.has(block.id)) continue;
					toolCalls.push(block);
				}
			}

			if (thinkingParts.length > 0) {
				parts.push(`[Think]: ${thinkingParts.join("\n")}`);
			}
			if (textParts.length > 0) {
				parts.push(`[Assistant]: ${textParts.join("\n")}`);
			}
			if (toolCalls.length > 0) {
				parts.push(`[Tool Call]: ${renderToolCalls(toolCalls)}`);
			}
		} else if (msg.role === "toolResult") {
			if (uselessCallIds.has(msg.toolCallId)) continue;
			const content = msg.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map(c => c.text)
				.join("");
			if (content) {
				const text = truncateToolResultForSummary(content);
				parts.push(`[Tool Result]: ${text}`);
			}
		}
	}

	return parts.join("\n\n");
}

/**
 * Render an assistant turn's tool calls as a compact `name(args)` list for the
 * legacy serializer.
 */
function renderToolCalls(calls: ToolCall[]): string {
	return calls
		.map(call => {
			const argsStr = Object.entries(call.arguments as Record<string, unknown>)
				.map(([k, v]) => `${k}=${stringifyJson(v) ?? "null"}`)
				.join(", ");
			return `${call.name}(${argsStr})`;
		})
		.join("; ");
}

// ============================================================================
// Summarization System Prompt
// ============================================================================

export const SUMMARIZATION_SYSTEM_PROMPT = prompt.render(AGENT_PROMPTS["compaction/summarization-system"].text);
