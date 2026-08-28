import { parseJsonWithRepair, parseStreamingJson } from "@veyyon/utils/json-parse";
import { AI_PROMPTS } from "../prompts/registry";
import type { ToolCall } from "../types";
import { mintToolCallId, partialSuffixOverlapAny, recordOrEmpty } from "./coercion";
import { chatMlTranscriptRenderer, renderThinkTags, renderToolResponseResults, stringifyJson } from "./rendering";
import type {
	DialectDefinition,
	DialectRenderOptions,
	InbandScanEvent,
	InbandScanner,
	InbandScannerOptions,
} from "./types";
import { THINK_CLOSE, THINK_OPEN, TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from "./wire-tags";

const HOLD_TAGS = [TOOL_CALL_OPEN, TOOL_CALL_CLOSE, THINK_OPEN, THINK_CLOSE] as const;

class HermesInbandScanner implements InbandScanner {
	#buffer = "";
	#inside = false;
	#id = "";
	#name = "";
	#started = false;
	#parseThinking: boolean;
	#inThinking = false;
	#thinking = "";

	constructor(options: InbandScannerOptions = {}) {
		this.#parseThinking = options.parseThinking === true;
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
			if (this.#inThinking) {
				const closeThink = this.#buffer.indexOf(THINK_CLOSE);
				if (closeThink === -1) {
					const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, [THINK_CLOSE]);
					const thinking = this.#buffer.slice(0, this.#buffer.length - hold);
					if (thinking.length > 0) {
						this.#thinking += thinking;
						events.push({ type: "thinkingDelta", delta: thinking });
					}
					this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
					if (final) {
						events.push({ type: "thinkingEnd", thinking: this.#thinking });
						this.#thinking = "";
						this.#inThinking = false;
					}
					break;
				}
				const thinking = this.#buffer.slice(0, closeThink);
				if (thinking.length > 0) {
					this.#thinking += thinking;
					events.push({ type: "thinkingDelta", delta: thinking });
				}
				this.#buffer = this.#buffer.slice(closeThink + THINK_CLOSE.length);
				events.push({ type: "thinkingEnd", thinking: this.#thinking });
				this.#thinking = "";
				this.#inThinking = false;
				continue;
			}

			if (!this.#inside) {
				const open = this.#buffer.indexOf(TOOL_CALL_OPEN);
				const think = this.#parseThinking ? this.#buffer.indexOf(THINK_OPEN) : -1;
				const start = open === -1 ? think : think === -1 ? open : Math.min(open, think);
				if (start === -1) {
					const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, HOLD_TAGS);
					const emit = this.#buffer.slice(0, this.#buffer.length - hold);
					if (emit.length > 0) events.push({ type: "text", text: emit });
					this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
					break;
				}
				if (start > 0) events.push({ type: "text", text: this.#buffer.slice(0, start) });
				if (start === think) {
					this.#buffer = this.#buffer.slice(start + THINK_OPEN.length);
					this.#inThinking = true;
					this.#thinking = "";
					events.push({ type: "thinkingStart" });
					continue;
				}
				this.#buffer = this.#buffer.slice(start + TOOL_CALL_OPEN.length);
				this.#inside = true;
				this.#id = mintToolCallId();
				this.#name = "";
				this.#started = false;
				continue;
			}

			const close = this.#buffer.indexOf(TOOL_CALL_CLOSE);
			const body = close === -1 ? this.#buffer : this.#buffer.slice(0, close);
			if (!this.#started) this.#tryStart(body, events);
			if (close === -1) {
				if (final) {
					this.#emitBestEffortEnd(body, `${TOOL_CALL_OPEN}${body}`, events);
					this.#reset();
				}
				break;
			}

			const parsed = this.#parseCall(body);
			const rawBlock = `${TOOL_CALL_OPEN}${body}${TOOL_CALL_CLOSE}`;
			if (parsed) {
				if (!this.#started) {
					events.push({ type: "toolStart", id: this.#id, name: parsed.name });
					this.#started = true;
				}
				events.push({ type: "toolEnd", id: this.#id, name: parsed.name, arguments: parsed.arguments, rawBlock });
			} else {
				this.#emitBestEffortEnd(body, rawBlock, events);
			}
			this.#buffer = this.#buffer.slice(close + TOOL_CALL_CLOSE.length);
			this.#reset();
		}
		return events;
	}

	#tryStart(body: string, events: InbandScanEvent[]): void {
		try {
			const partial = parseStreamingJson<{ name?: unknown }>(body);
			if (typeof partial.name !== "string" || partial.name.length === 0) return;
			this.#name = partial.name;
			this.#started = true;
			events.push({ type: "toolStart", id: this.#id, name: this.#name });
		} catch {}
	}

	#parseCall(body: string): { name: string; arguments: Record<string, unknown> } | undefined {
		try {
			const parsed = parseJsonWithRepair<{ name?: unknown; arguments?: unknown }>(body.trim());
			if (typeof parsed.name !== "string" || parsed.name.length === 0) return undefined;
			let args = parsed.arguments;
			if (typeof args === "string") {
				args = parseJsonWithRepair<unknown>(args);
			}
			return { name: parsed.name, arguments: recordOrEmpty(args) };
		} catch {
			return undefined;
		}
	}

	#emitBestEffortEnd(body: string, rawBlock: string, events: InbandScanEvent[]): void {
		if (!this.#started) return;
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

	#reset(): void {
		this.#inside = false;
		this.#id = "";
		this.#name = "";
		this.#started = false;
	}
}

function renderToolCall(call: ToolCall, _options: DialectRenderOptions = {}): string {
	return `${TOOL_CALL_OPEN}\n${stringifyJson({ name: call.name, arguments: call.arguments })}\n${TOOL_CALL_CLOSE}`;
}

function renderAssistantToolCalls(calls: readonly ToolCall[], options: DialectRenderOptions = {}): string {
	return calls.map(call => renderToolCall(call, options)).join("\n");
}

const definition: DialectDefinition = {
	dialect: "hermes",
	prompt: AI_PROMPTS["dialect/hermes"].text,
	createScanner: options => new HermesInbandScanner(options),
	renderToolCall,
	renderAssistantToolCalls,
	renderToolResults: renderToolResponseResults,
	renderThinking: renderThinkTags,
	renderTranscript: chatMlTranscriptRenderer({
		toolResultRole: "tool",
		renderThinking: renderThinkTags,
		renderCalls: renderAssistantToolCalls,
		renderResultsBody: renderToolResponseResults,
	}),
};

export default definition;
