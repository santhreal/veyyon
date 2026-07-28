import { stringifyJson as stringifyJsonValue } from "@veyyon/utils/json";
import { escapeXmlAttribute, escapeXmlText } from "@veyyon/utils/sanitize-text";
import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "../types";
import { buildArgShapes, type ToolArgShape } from "./coercion";
import type { DialectRenderOptions, DialectToolResult } from "./types";
import {
	THINK_CLOSE,
	THINK_OPEN,
	TOOL_RESPONSE_CLOSE,
	TOOL_RESPONSE_OPEN,
	XML_THINKING_CLOSE,
	XML_THINKING_OPEN,
} from "./wire-tags";

export function renderToolResponseResults(results: readonly DialectToolResult[]): string {
	return results.map(result => `${TOOL_RESPONSE_OPEN}\n${result.text}\n${TOOL_RESPONSE_CLOSE}`).join("\n");
}

/**
 * One tool call as Anthropic's `<invoke>` element.
 *
 * Three dialects speak this syntax: `anthropic` itself, `xml`, and `minimax`, which wraps
 * the same invokes in a tag of its own. All three had a byte-identical private copy of this
 * function and of {@link renderInvokes}, which is a wire format restated three times: a
 * change to the escaping or to the string-argument rule in one of them would leave the
 * other two rendering a shape the model was not prompted for, and the only symptom is a
 * model that stops calling tools properly.
 *
 * `shape` decides which arguments the model wrote as bare text. An argument the tool
 * declares as a string is emitted verbatim, so a code snippet keeps its newlines and
 * quotes; anything else is JSON, so a number stays a number when it is parsed back.
 */
export function renderInvoke(call: ToolCall, shape: ToolArgShape | undefined): string {
	let body = `<invoke name="${escapeXmlAttribute(call.name)}">`;
	for (const key in call.arguments) {
		const value = call.arguments[key];
		const isString = shape?.stringArgs.has(key) === true;
		const rendered = isString && typeof value === "string" ? value : stringifyJson(value);
		body += `<parameter name="${escapeXmlAttribute(key)}">${rendered}</parameter>`;
	}
	return `${body}</invoke>`;
}

/** Every call in a turn as `<invoke>` elements, one per line. See {@link renderInvoke}. */
export function renderInvokes(calls: readonly ToolCall[], tools: NonNullable<DialectRenderOptions["tools"]>): string {
	const shapes = buildArgShapes(tools);
	return calls.map(call => renderInvoke(call, shapes.get(call.name))).join("\n");
}

/**
 * A single tool call rendered on its own, which is what the tool-call preview asks for.
 *
 * The same one-liner in all three dialects: look up the call's argument shape and render
 * the invoke. It is separate from {@link renderInvokes} because that one takes a whole turn
 * and builds the shape table once.
 */
export function renderInvokeToolCall(call: ToolCall, options: DialectRenderOptions = {}): string {
	return renderInvoke(call, buildArgShapes(options.tools).get(call.name));
}

/**
 * Tool results as Anthropic's `<function_results>` block.
 *
 * Shared by `anthropic` and `minimax`, which had identical copies. A failed call is
 * reported as `<error>` with the text on `<stderr>`, so the model can tell a failure from
 * an empty result: collapsing the two is how a model ends up retrying a call that
 * succeeded, or treating an error as data.
 */
export function renderFunctionResults(results: readonly DialectToolResult[]): string {
	const body = results
		.map(result => {
			const tag = result.isError ? "error" : "result";
			const streamTag = result.isError ? "stderr" : "stdout";
			return `<${tag}>\n<tool_name>${escapeXmlText(result.name)}</tool_name>\n<${streamTag}>${result.text}</${streamTag}>\n</${tag}>`;
		})
		.join("\n");
	return `<function_results>\n${body}\n</function_results>`;
}

/**
 * Bind a legacy-text transcript configuration into the renderer a dialect definition
 * exposes.
 *
 * Every dialect in that family wrote the same three-line wrapper around
 * {@link renderLegacyTextTranscript}, differing only in the three functions it closed over,
 * so the wrapper was byte-identical in each of them while meaning something different.
 * Binding the config once says the same thing without the copy.
 */
export function legacyTextTranscriptRenderer(
	config: LegacyTextTranscriptConfig,
): (messages: readonly Message[], options?: DialectRenderOptions) => string {
	return (messages, options = {}) => renderLegacyTextTranscript(messages, options, config);
}

/** {@link legacyTextTranscriptRenderer} for the ChatML family. */
export function chatMlTranscriptRenderer(
	config: ChatMlTranscriptConfig,
): (messages: readonly Message[], options?: DialectRenderOptions) => string {
	return (messages, options = {}) => renderChatMlTranscript(messages, options, config);
}

export function kimiCallId(name: string, id: string, index: number): string {
	const trimmed = id.trim();
	return trimmed.startsWith("functions.") ? trimmed : `functions.${name}:${index}`;
}

export function harmonyRecipient(name: string): string {
	return name.startsWith("functions.") ? name : `functions.${name}`;
}

export function stringifyJson(value: unknown): string {
	return stringifyJsonValue(value) ?? "null";
}

// XML escaping has ONE owner in @veyyon/utils: `escapeXmlText` (escapes `&`,
// `<`, `>`) and `escapeXmlAttribute` (also escapes `"` for attribute values),
// both single-pass with a no-alloc fast path. Re-exported here (the attribute
// one under this module's shorter `escapeXmlAttr` name) so dialect modules keep
// importing them from `./rendering` alongside the other render helpers. Behavior
// parity with the naive replaceAll chains these replaced is locked by the
// differentials in utils/test/sanitize-text.test.ts.
export { escapeXmlAttribute as escapeXmlAttr, escapeXmlText } from "@veyyon/utils/sanitize-text";

export type AssistantTranscriptParts = {
	readonly text: string;
	readonly thinking: string;
	readonly toolCalls: readonly ToolCall[];
};

export type ToolCallRenderer = (calls: readonly ToolCall[], options?: DialectRenderOptions) => string;
export type ToolResultRenderer = (results: readonly DialectToolResult[], options?: DialectRenderOptions) => string;

export type ChatMlTranscriptConfig = {
	readonly bos?: string;
	readonly toolResultRole: "tool" | "user";
	readonly renderThinking: (text: string) => string;
	readonly renderCalls: ToolCallRenderer;
	readonly renderResultsBody: ToolResultRenderer;
};

export type LegacyTextTranscriptConfig = {
	readonly renderThinking: (text: string) => string;
	readonly renderCalls: ToolCallRenderer;
	readonly renderResults: ToolResultRenderer;
};

export function renderChatMlTranscript(
	messages: readonly Message[],
	options: DialectRenderOptions,
	config: ChatMlTranscriptConfig,
): string {
	if (messages.length === 0) return "";
	let out = config.bos ?? "";
	for (let i = 0; i < messages.length; ) {
		const message = messages[i]!;
		if (message.role === "assistant") {
			const parts = assistantTranscriptParts(message);
			out += chatMlTurn(
				"assistant",
				`${config.renderThinking(parts.thinking)}${parts.text}${config.renderCalls(parts.toolCalls, options)}`,
			);
			i++;
			continue;
		}
		if (message.role === "toolResult") {
			const run = collectToolResultRun(messages, i);
			out += chatMlTurn(config.toolResultRole, config.renderResultsBody(run.results, options));
			i = run.next;
			continue;
		}
		const role = message.role === "developer" ? "system" : message.role;
		out += chatMlTurn(role, messageContentText(message.content));
		i++;
	}
	return out;
}

export function renderLegacyTextTranscript(
	messages: readonly Message[],
	options: DialectRenderOptions,
	config: LegacyTextTranscriptConfig,
): string {
	let out = "";
	for (let i = 0; i < messages.length; ) {
		const message = messages[i]!;
		if (message.role === "assistant") {
			const parts = assistantTranscriptParts(message);
			out = appendLegacySegment(
				out,
				`Assistant: ${config.renderThinking(parts.thinking)}${parts.text}${config.renderCalls(parts.toolCalls, options)}`,
			);
			i++;
			continue;
		}
		if (message.role === "toolResult") {
			const run = collectToolResultRun(messages, i);
			out = appendLegacySegment(out, `Human: ${config.renderResults(run.results, options)}`);
			i = run.next;
			continue;
		}
		const text = messageContentText(message.content);
		out = message.role === "developer" ? appendLegacyPlain(out, text) : appendLegacySegment(out, `Human: ${text}`);
		i++;
	}
	return out;
}

export function assistantTranscriptParts(message: AssistantMessage): AssistantTranscriptParts {
	let text = "";
	const thinking: string[] = [];
	const toolCalls: ToolCall[] = [];
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
		else if (block.type === "thinking") thinking.push(block.thinking);
		else if (block.type === "toolCall") toolCalls.push(block);
	}
	return { text, thinking: thinking.join("\n"), toolCalls };
}

export function collectToolResultRun(
	messages: readonly Message[],
	start: number,
): { readonly results: readonly DialectToolResult[]; readonly next: number } {
	const results: DialectToolResult[] = [];
	let next = start;
	while (next < messages.length && messages[next]!.role === "toolResult") {
		results.push(toolResultToDialectResult(messages[next] as ToolResultMessage, results.length));
		next++;
	}
	return { results, next };
}

function toolResultToDialectResult(message: ToolResultMessage, index: number): DialectToolResult {
	return {
		id: message.toolCallId,
		name: message.toolName,
		index,
		text: messageContentText(message.content),
		isError: message.isError,
	};
}

export function messageContentText(
	content: string | readonly { readonly type: string; readonly text?: string; readonly mimeType?: string }[],
): string {
	if (typeof content === "string") return content;
	let text = "";
	for (const block of content) {
		if (block.type === "text" && block.text !== undefined) text += block.text;
		else if (block.type === "image") text += block.mimeType ? `[Image: ${block.mimeType}]` : "[Image]";
	}
	return text;
}

function isAsciiWhitespace(code: number): boolean {
	return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
}

function trimAsciiStart(text: string, start: number, end: number): number {
	let cursor = start;
	while (cursor < end && isAsciiWhitespace(text.charCodeAt(cursor))) cursor++;
	return cursor;
}

function trimAsciiEnd(text: string, start: number, end: number): number {
	let cursor = end;
	while (cursor > start && isAsciiWhitespace(text.charCodeAt(cursor - 1))) cursor--;
	return cursor;
}

function findDelimitedThinkingClose(open: string, close: string, text: string, start: number, end: number): number {
	let depth = 1;
	let cursor = start;
	while (cursor < end) {
		const nextClose = text.indexOf(close, cursor);
		if (nextClose < 0 || nextClose >= end) return -1;
		const nextOpen = text.indexOf(open, cursor);
		if (nextOpen >= 0 && nextOpen < nextClose) {
			depth++;
			cursor = nextOpen + open.length;
			continue;
		}
		depth--;
		if (depth === 0) return nextClose;
		cursor = nextClose + close.length;
	}
	return -1;
}

function unwrapDelimitedThinking(open: string, close: string, text: string): string {
	const end = trimAsciiEnd(text, 0, text.length);
	let cursor = trimAsciiStart(text, 0, end);
	if (cursor >= end || !text.startsWith(open, cursor)) return text;

	const segments: string[] = [];
	while (cursor < end) {
		if (!text.startsWith(open, cursor)) return text;
		const innerStart = cursor + open.length;
		const innerEnd = findDelimitedThinkingClose(open, close, text, innerStart, end);
		if (innerEnd < 0) return text;

		const trimmedInnerEnd = trimAsciiEnd(text, innerStart, innerEnd);
		const trimmedInnerStart = trimAsciiStart(text, innerStart, trimmedInnerEnd);
		segments.push(unwrapDelimitedThinking(open, close, text.slice(trimmedInnerStart, trimmedInnerEnd)));
		cursor = trimAsciiStart(text, innerEnd + close.length, end);
	}
	return segments.join("\n");
}

export function renderDelimitedThinking(open: string, close: string, text: string): string {
	if (!text) return "";
	return `${open}\n${unwrapDelimitedThinking(open, close, text)}\n${close}`;
}

/**
 * Render thinking text inside the shared `<think>` envelope. Collapses tags that
 * are already present rather than nesting a second envelope around them.
 */
export function renderThinkTags(text: string): string {
	return renderDelimitedThinking(THINK_OPEN, THINK_CLOSE, text);
}

/** Render thinking text inside the shared `<thinking>` envelope. */
export function renderXmlThinkingTags(text: string): string {
	return renderDelimitedThinking(XML_THINKING_OPEN, XML_THINKING_CLOSE, text);
}

export function chatMlTurn(role: "assistant" | "system" | "tool" | "user", body: string): string {
	return `<|im_start|>${role}\n${body}<|im_end|>\n`;
}

export function kimiTurn(role: "assistant" | "system" | "user", name: string, body: string): string {
	return `<|im_${role}|>${name}<|im_middle|>${body}<|im_end|>`;
}

export function gemmaTurn(role: "model" | "system" | "user", body: string): string {
	return `<|turn>${role}\n${body}<turn|>`;
}

export function geminiTurn(role: "model" | "user", body: string): string {
	return `<start_of_turn>${role}\n${body}<end_of_turn>\n`;
}

export function joinUserBodies(left: string, right: string): string {
	if (!left) return right;
	if (!right) return left;
	return `${left}\n${right}`;
}

function appendLegacyPlain(out: string, text: string): string {
	if (!text) return out;
	return out ? `${out}\n\n${text}` : text;
}

function appendLegacySegment(out: string, segment: string): string {
	return `${out}\n\n${segment}`;
}
