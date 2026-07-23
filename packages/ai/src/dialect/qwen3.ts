import { parseJsonWithRepair, parseStreamingJson } from "@veyyon/utils";
import type { Message, ToolCall } from "../types";
import { mintToolCallId, partialSuffixOverlapAny, recordOrEmpty } from "./coercion";
import dialectPrompt from "./qwen3.md" with { type: "text" };
import {
	renderChatMlTranscript,
	renderThinkTags,
	renderToolResponseResults,
	stringifyJson,
	THINK_CLOSE,
	THINK_OPEN,
} from "./rendering";
import type {
	DialectDefinition,
	DialectRenderOptions,
	DialectToolResult,
	InbandScanEvent,
	InbandScanner,
	InbandScannerOptions,
} from "./types";

const TOOL_OPEN = "<tool_call>";
const TOOL_CLOSE = "</tool_call>";

const TOOL_START_TAGS = [TOOL_OPEN] as const;
const START_TAGS = [TOOL_OPEN, THINK_OPEN] as const;
const THINK_CLOSE_TAGS = [THINK_CLOSE] as const;
const COMPLETE_NAME = /^\s*\{\s*"name"\s*:\s*("(?:\\.|[^"\\])*")/;

type State = "outside" | "thinking" | "tool";

export class Qwen3InbandScanner implements InbandScanner {
	#buffer = "";
	#state: State = "outside";
	#id = "";
	#name = "";
	#started = false;
	#thinking = "";
	readonly #parseThinking: boolean;

	constructor(options: InbandScannerOptions = {}) {
		this.#parseThinking = options.parseThinking !== false;
	}

	feed(text: string): InbandScanEvent[] {
		if (text.length === 0) return [];
		this.#buffer += text;
		return this.#consume(false);
	}

	flush(): InbandScanEvent[] {
		return this.#consume(true);
	}

	#consume(final: boolean): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		while (this.#buffer.length > 0) {
			if (this.#state === "outside") {
				this.#consumeOutside(final, events);
				if (this.#state === "outside") break;
				continue;
			}

			if (this.#state === "thinking") {
				this.#consumeThinking(final, events);
				if (this.#state === "thinking") break;
				continue;
			}

			this.#consumeTool(final, events);
			if (this.#state === "tool") break;
		}
		if (final && this.#state === "thinking") this.#endThinking(events);
		return events;
	}

	#consumeOutside(final: boolean, events: InbandScanEvent[]): void {
		const tool = this.#buffer.indexOf(TOOL_OPEN);
		const think = this.#parseThinking ? this.#buffer.indexOf(THINK_OPEN) : -1;
		let start = tool;
		let isThink = false;
		if (think !== -1 && (start === -1 || think < start)) {
			start = think;
			isThink = true;
		}

		if (start === -1) {
			const tags = this.#parseThinking ? START_TAGS : TOOL_START_TAGS;
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, tags);
			const emit = this.#buffer.slice(0, this.#buffer.length - hold);
			if (emit.length > 0) events.push({ type: "text", text: emit });
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			return;
		}

		if (start > 0) events.push({ type: "text", text: this.#buffer.slice(0, start) });
		if (isThink) {
			this.#buffer = this.#buffer.slice(start + THINK_OPEN.length);
			this.#state = "thinking";
			this.#thinking = "";
			events.push({ type: "thinkingStart" });
			return;
		}

		this.#buffer = this.#buffer.slice(start + TOOL_OPEN.length);
		this.#state = "tool";
		this.#id = mintToolCallId();
		this.#name = "";
		this.#started = false;
	}

	#consumeThinking(final: boolean, events: InbandScanEvent[]): void {
		const close = this.#buffer.indexOf(THINK_CLOSE);
		if (close === -1) {
			const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, THINK_CLOSE_TAGS);
			const delta = this.#buffer.slice(0, this.#buffer.length - hold);
			this.#emitThinkingDelta(delta, events);
			this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
			if (final) this.#endThinking(events);
			return;
		}

		this.#emitThinkingDelta(this.#buffer.slice(0, close), events);
		this.#buffer = this.#buffer.slice(close + THINK_CLOSE.length);
		this.#endThinking(events);
	}

	#consumeTool(final: boolean, events: InbandScanEvent[]): void {
		const close = this.#buffer.indexOf(TOOL_CLOSE);
		const body = close === -1 ? this.#buffer : this.#buffer.slice(0, close);
		if (!this.#started) this.#tryStart(body, events);
		if (close === -1) {
			if (final) {
				// Stream ended with no closing tag. A toolStart already announced here
				// MUST be balanced by a toolEnd, or the downstream projector dispatches
				// the named tool with the empty {} args it seeded on toolStart.
				this.#emitBestEffortEnd(body, `${TOOL_OPEN}${body}`, events);
				this.#resetTool();
			}
			return;
		}

		const parsed = this.#parseCall(body);
		const rawBlock = `${TOOL_OPEN}${body}${TOOL_CLOSE}`;
		if (parsed) {
			if (!this.#started) {
				events.push({ type: "toolStart", id: this.#id, name: parsed.name });
				this.#started = true;
			}
			events.push({ type: "toolEnd", id: this.#id, name: parsed.name, arguments: parsed.arguments, rawBlock });
		} else {
			// Body closed but did not parse. Balance an already-announced toolStart
			// with a best-effort toolEnd rather than stranding a half-open call.
			this.#emitBestEffortEnd(body, rawBlock, events);
		}
		this.#buffer = this.#buffer.slice(close + TOOL_CLOSE.length);
		this.#resetTool();
	}

	/**
	 * Balance an already-announced toolStart with a toolEnd when the body could
	 * not be parsed (truncated stream or malformed JSON). Salvages whatever named
	 * arguments partial parsing can recover, else empty, so the tool block is
	 * finalized instead of dispatched half-open with empty args.
	 */
	#emitBestEffortEnd(body: string, rawBlock: string, events: InbandScanEvent[]): void {
		if (!this.#started) return;
		// #name was captured early from a PARTIAL body (it may be a prefix like "r"
		// of "read"); re-derive the fuller name from the current body when possible.
		let name = this.#name;
		let args: unknown;
		try {
			const partial = parseStreamingJson<{ name?: unknown; arguments?: unknown }>(body);
			if (typeof partial.name === "string" && partial.name.length > name.length) name = partial.name;
			args = partial.arguments;
		} catch {
			args = undefined;
		}
		events.push({ type: "toolEnd", id: this.#id, name, arguments: recordOrEmpty(args), rawBlock });
	}

	#emitThinkingDelta(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		this.#thinking += delta;
		events.push({ type: "thinkingDelta", delta });
	}

	#endThinking(events: InbandScanEvent[]): void {
		events.push({ type: "thinkingEnd", thinking: this.#thinking });
		this.#thinking = "";
		this.#state = "outside";
	}

	#tryStart(body: string, events: InbandScanEvent[]): void {
		const nameMatch = COMPLETE_NAME.exec(body);
		if (!nameMatch) return;
		let name: unknown;
		try {
			name = JSON.parse(nameMatch[1]!);
		} catch {
			return;
		}
		if (typeof name !== "string" || name.length === 0) return;
		this.#name = name;
		this.#started = true;
		events.push({ type: "toolStart", id: this.#id, name: this.#name });
	}

	#parseCall(body: string): { name: string; arguments: Record<string, unknown> } | undefined {
		try {
			const parsed = parseJsonWithRepair<{ name?: unknown; arguments?: unknown }>(body.trim());
			if (typeof parsed.name !== "string" || parsed.name.length === 0) return undefined;
			let args = parsed.arguments;
			if (typeof args === "string") {
				// Double-encoded arguments: parse the stringified object. If unrepairable,
				// let it throw to the outer catch so the one best-effort-end path handles
				// it — never silently replaced with {} here (a Law-10 silent fallback).
				args = parseJsonWithRepair<unknown>(args);
			}
			return { name: parsed.name, arguments: recordOrEmpty(args) };
		} catch {
			return undefined;
		}
	}

	#resetTool(): void {
		this.#state = "outside";
		this.#id = "";
		this.#name = "";
		this.#started = false;
	}
}

function renderToolCall(call: ToolCall, _options: DialectRenderOptions = {}): string {
	return `${TOOL_OPEN}\n${stringifyJson({ name: call.name, arguments: call.arguments })}\n${TOOL_CLOSE}`;
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	return calls.map(call => renderToolCall(call, options)).join("\n");
}

function renderToolResults(results: readonly DialectToolResult[], _options: DialectRenderOptions = {}): string {
	return renderToolResponseResults(results);
}

function renderThinking(text: string): string {
	return renderThinkTags(text);
}

function renderTranscript(messages: readonly Message[], options: DialectRenderOptions = {}): string {
	return renderChatMlTranscript(messages, options, {
		toolResultRole: "user",
		renderThinking,
		renderCalls: renderAssistantToolCalls,
		renderResultsBody: renderToolResults,
	});
}

const definition: DialectDefinition = {
	dialect: "qwen3",
	prompt: dialectPrompt,
	createScanner: options => new Qwen3InbandScanner(options),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults,
	renderThinking,
	renderTranscript,
};

export default definition;
