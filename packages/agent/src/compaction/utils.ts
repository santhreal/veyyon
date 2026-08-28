import type { Message, ToolCall } from "@veyyon/ai";
import type { Dialect } from "@veyyon/ai/dialect";
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

export { splitReadSelector, stripReadSelector };

export function isUrlSchemePath(path: string): boolean {
	return containsUrlScheme(path);
}

export function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return;
	for (const block of message.content) {
		if (block.type !== "toolCall" || block.name !== "read") continue;
		const args = block.arguments as Record<string, unknown> | undefined;
		const path = typeof args?.path === "string" ? args.path : undefined;
		if (path && !isUrlSchemePath(path)) fileOps.read.add(stripReadSelector(path));
	}
}

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

export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
	const modified = new Set<string>();
	for (const f of fileOps.edited) if (!isUrlSchemePath(f)) modified.add(f);
	for (const f of fileOps.written) if (!isUrlSchemePath(f)) modified.add(f);
	const readOnly = Array.from(fileOps.read)
		.filter(f => !isUrlSchemePath(f) && !modified.has(f))
		.sort();
	const modifiedFiles = Array.from(modified).sort();
	return { readFiles: readOnly, modifiedFiles };
}

const FILE_OPERATION_SUMMARY_LIMIT = 20;

function stripFileOperationTags(summary: string): string {
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
	const all = Array.from(mode.keys()).sort();
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

const TOOL_RESULT_MAX_CHARS = 2000;

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

export function serializeConversationForSummary(messages: Message[], dialect?: Dialect): string {
	const conversation = serializeConversation(messages, dialect);
	if (dialect !== "harmony") return conversation;
	return conversation.replace(HARMONY_CONTROL_TOKEN_RE, "<\\|$1\\|>");
}

export function serializeConversation(messages: Message[], dialect?: Dialect): string {
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

export const SUMMARIZATION_SYSTEM_PROMPT = prompt.render(AGENT_PROMPTS["compaction/summarization-system"].text);
