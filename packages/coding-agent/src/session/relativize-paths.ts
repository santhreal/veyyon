import type { AssistantMessage, Message, TextContent, ToolResultMessage } from "@veyyon/ai";
import { escapeRegExp } from "@veyyon/utils";
import { SET_CWD_TOOL_NAME } from "../tools/reroot-hint";

export interface RelativizeResult {
	messages: Message[];
	bytesSaved: number;
}

export function normalizeRoots(root: string): string[] {
	let normalized = root.trim();
	while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
	if (normalized.length > 1 && normalized.startsWith("/")) return [normalized];
	return [];
}

const BOUNDARY_CHARS = new Set([" ", "\t", "\n", "\r", "(", "[", "{", "<", '"', "'", "`", "=", ":", ";", ","]);

interface CompiledRoot {
	root: string;
	prefix: RegExp;
	exact: RegExp;
}

function compileRoot(root: string): CompiledRoot {
	const escaped = escapeRegExp(root);
	return {
		root,
		prefix: new RegExp(`${escaped}/`, "g"),
		exact: new RegExp(`${escaped}(?=$|[\\s\\])}>"'\\\`;:,.])`, "g"),
	};
}

function relativizeText(text: string, compiled: readonly CompiledRoot[]): { text: string; saved: number } | undefined {
	let saved = 0;
	let out = text;
	for (const { prefix, exact } of compiled) {
		out = out.replace(prefix, (match, offset: number) => {
			if (offset !== 0 && !BOUNDARY_CHARS.has(out[offset - 1])) return match;
			saved += match.length;
			return "";
		});
		out = out.replace(exact, (match, offset: number) => {
			if (offset !== 0 && !BOUNDARY_CHARS.has(out[offset - 1])) return match;
			saved += match.length - 1;
			return ".";
		});
	}
	return saved === 0 ? undefined : { text: out, saved };
}

function relativizeArguments(value: unknown, roots: readonly string[], state: { changed: boolean }): unknown {
	if (typeof value === "string") {
		if (value.includes("\n")) return value;
		for (const root of roots) {
			if (value === root) {
				state.changed = true;
				return ".";
			}
			if (value.startsWith(`${root}/`)) {
				state.changed = true;
				return value.slice(root.length + 1);
			}
		}
		return value;
	}
	if (Array.isArray(value)) {
		let items: unknown[] | undefined;
		for (let i = 0; i < value.length; i++) {
			const next = relativizeArguments(value[i], roots, state);
			if (next !== value[i]) {
				items ??= value.slice();
				items[i] = next;
			}
		}
		return items ?? value;
	}
	if (value !== null && typeof value === "object") {
		let record: Record<string, unknown> | undefined;
		for (const [key, item] of Object.entries(value)) {
			const next = relativizeArguments(item, roots, state);
			if (next !== item) {
				record ??= { ...(value as Record<string, unknown>) };
				record[key] = next;
			}
		}
		return record ?? value;
	}
	return value;
}

function relativizeAssistant(
	message: AssistantMessage,
	roots: readonly string[],
	compiled: readonly CompiledRoot[],
	state: { saved: number },
): AssistantMessage {
	let content: AssistantMessage["content"] | undefined;
	for (let i = 0; i < message.content.length; i++) {
		const block = message.content[i];
		if (block.type === "text") {
			const next = relativizeText(block.text, compiled);
			if (next) {
				content ??= message.content.slice();
				content[i] = { ...block, text: next.text };
				state.saved += next.saved;
			}
		} else if (block.type === "toolCall") {
			const argState = { changed: false };
			const args = relativizeArguments(block.arguments, roots, argState);
			if (argState.changed) {
				content ??= message.content.slice();
				content[i] = { ...block, arguments: args as Record<string, unknown> };
			}
		}
	}
	return content ? { ...message, content } : message;
}

function relativizeMessage(
	message: Message,
	roots: readonly string[],
	compiled: readonly CompiledRoot[],
	state: { saved: number },
): Message {
	if (message.role === "assistant") {
		return relativizeAssistant(message, roots, compiled, state);
	}
	if (message.role === "toolResult") {
		if (message.toolName === SET_CWD_TOOL_NAME) return message;
		const result: ToolResultMessage = message;
		let content: ToolResultMessage["content"] | undefined;
		for (let i = 0; i < result.content.length; i++) {
			const block = result.content[i];
			if (block.type !== "text") continue;
			const next = relativizeText(block.text, compiled);
			if (next) {
				content ??= result.content.slice();
				content[i] = { ...block, text: next.text } as TextContent;
				state.saved += next.saved;
			}
		}
		return content ? { ...result, content } : message;
	}
	if (typeof message.content === "string") {
		const next = relativizeText(message.content, compiled);
		if (!next) return message;
		state.saved += next.saved;
		return { ...message, content: next.text };
	}
	let content: typeof message.content | undefined;
	for (let i = 0; i < message.content.length; i++) {
		const block = message.content[i];
		if (block.type !== "text") continue;
		const next = relativizeText(block.text, compiled);
		if (next) {
			content ??= message.content.slice();
			content[i] = { ...block, text: next.text };
			state.saved += next.saved;
		}
	}
	return content ? { ...message, content } : message;
}

export interface PathRelativizer {
	transform(message: Message): { message: Message; bytesSaved: number };
}

export function createPathRelativizer(roots: readonly string[]): PathRelativizer {
	const compiled = roots.map(compileRoot);
	return {
		transform(message) {
			const state = { saved: 0 };
			return {
				message: relativizeMessage(message, roots, compiled, state),
				bytesSaved: state.saved,
			};
		},
	};
}

export function relativizePathsUnderRoots(messages: Message[], roots: readonly string[]): RelativizeResult {
	if (messages.length === 0 || roots.length === 0) return { messages, bytesSaved: 0 };
	const relativizer = createPathRelativizer(roots);
	let bytesSaved = 0;
	let out: Message[] | undefined;
	for (let i = 0; i < messages.length; i++) {
		const next = relativizer.transform(messages[i]);
		bytesSaved += next.bytesSaved;
		if (next.message !== messages[i]) {
			out ??= messages.slice();
			out[i] = next.message;
		}
	}
	return { messages: out ?? messages, bytesSaved };
}
