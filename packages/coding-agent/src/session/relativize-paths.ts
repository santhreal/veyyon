/**
 * Outbound path-prefix canonicalization (TW-10).
 *
 * Absolute paths under the session's registered roots are pure carry noise:
 * a long cwd prefix repeated thousands of times in stored history is re-sent
 * verbatim every turn. At the request-build boundary we render those paths
 * relative to their root; persisted history keeps the original absolute bytes
 * (fidelity/audit) and inbound model output passes through untouched (tools
 * resolve relative paths against the live cwd).
 *
 * Roots accumulate over the session (initial cwd plus every setCwd target, in
 * order), so a mid-session setCwd only grows the root set: old history keeps
 * rendering byte-identically and the prompt-cache prefix survives the change.
 */

import type { AssistantMessage, Message, TextContent, ToolResultMessage } from "@veyyon/ai";

export interface RelativizeResult {
	messages: Message[];
	/** Total characters removed from the outbound rendering this call. */
	bytesSaved: number;
}

/** Normalize, dedup, and sort roots longest-first so the longest prefix wins. */
export function normalizeRoots(roots: readonly string[]): string[] {
	const seen = new Set<string>();
	for (const root of roots) {
		let normalized = root.trim();
		while (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
		if (normalized.length > 1 && normalized.startsWith("/")) seen.add(normalized);
	}
	return [...seen].sort((a, b) => b.length - a.length);
}

const BOUNDARY_CHARS = new Set([" ", "\t", "\n", "\r", "(", "[", "{", "<", '"', "'", "`", "=", ":", ";", ","]);

interface CompiledRoot {
	root: string;
	/** root + "/" anywhere; left boundary enforced during the scan. */
	prefix: RegExp;
	/** bare root followed by a token-ending character or end of string. */
	exact: RegExp;
}

function compileRoot(root: string): CompiledRoot {
	const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return {
		root,
		prefix: new RegExp(`${escaped}/`, "g"),
		exact: new RegExp(`${escaped}(?=$|[\\s\\])}>"'\\\`;:,.])`, "g"),
	};
}

/** Rewrite absolute paths under roots in free text; undefined when unchanged. */
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
		// Whole-string path values only: a multiline string is content, not a path.
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
				items ??= [...value];
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
				content ??= [...message.content];
				content[i] = { ...block, text: next.text };
				state.saved += next.saved;
			}
		} else if (block.type === "toolCall") {
			const argState = { changed: false };
			const args = relativizeArguments(block.arguments, roots, argState);
			if (argState.changed) {
				content ??= [...message.content];
				content[i] = { ...block, arguments: args as Record<string, unknown> };
			}
		}
		// thinking / redactedThinking blocks are provider-signed: never rewrite.
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
		const result: ToolResultMessage = message;
		let content: ToolResultMessage["content"] | undefined;
		for (let i = 0; i < result.content.length; i++) {
			const block = result.content[i];
			if (block.type !== "text") continue;
			const next = relativizeText(block.text, compiled);
			if (next) {
				content ??= [...result.content];
				content[i] = { ...block, text: next.text } as TextContent;
				state.saved += next.saved;
			}
		}
		return content ? { ...result, content } : message;
	}
	// user / developer: string or block content, same text rewrite.
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
			content ??= [...message.content];
			content[i] = { ...block, text: next.text };
			state.saved += next.saved;
		}
	}
	return content ? { ...message, content } : message;
}

/**
 * Render absolute paths under `roots` (normalized via {@link normalizeRoots})
 * as root-relative in the outbound copy of `messages`. Returns the input
 * array untouched when nothing matched, preserving context identity so
 * callers can skip downstream cache-key churn.
 */
export function relativizePathsUnderRoots(messages: Message[], roots: readonly string[]): RelativizeResult {
	if (messages.length === 0 || roots.length === 0) return { messages, bytesSaved: 0 };
	const compiled = roots.map(compileRoot);
	const state = { saved: 0 };
	let out: Message[] | undefined;
	for (let i = 0; i < messages.length; i++) {
		const next = relativizeMessage(messages[i], roots, compiled, state);
		if (next !== messages[i]) {
			out ??= [...messages];
			out[i] = next;
		}
	}
	return { messages: out ?? messages, bytesSaved: state.saved };
}
