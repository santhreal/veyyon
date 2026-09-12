import { parseStreamingJson } from "@veyyon/utils/json-parse";
import { AI_PROMPTS } from "../prompts/registry";
import {
	emitBestEffortToolEnd,
	emitClosedToolCall,
	mintToolCallId,
	partialSuffixOverlapAny,
	scanThinkingText,
	ThinkingSection,
} from "./coercion";
import {
	chatMlTranscriptRenderer,
	renderJsonAssistantToolCalls,
	renderJsonToolCall,
	renderThinkTags,
	renderToolResponseResults,
} from "./rendering";
import type { DialectDefinition, InbandScanEvent, InbandScanner, InbandScannerOptions } from "./types";
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
	readonly #thinking = new ThinkingSection();

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
				const { buffer, closed } = scanThinkingText(this.#buffer, THINK_CLOSE, final, this.#thinking, events);
				this.#buffer = buffer;
				if (!closed) break;
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
					this.#thinking.start(events);
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
					// Stream ended with no closing tag. If a toolStart was already
					// announced, it MUST be balanced by a toolEnd — otherwise the
					// downstream projector keeps the half-open toolCall block it created
					// on toolStart (arguments: {}) and the agent dispatches the named
					// tool with EMPTY args. Emit a best-effort end before resetting.
					this.#emitBestEffortEnd(body, `${TOOL_CALL_OPEN}${body}`, events);
					this.#reset();
				}
				break;
			}

			emitClosedToolCall(
				this.#started,
				this.#id,
				this.#name,
				body,
				`${TOOL_CALL_OPEN}${body}${TOOL_CALL_CLOSE}`,
				events,
			);
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
		} catch {
			// Partial JSON is allowed until the closing tag arrives.
		}
	}

	#emitBestEffortEnd(body: string, rawBlock: string, events: InbandScanEvent[]): void {
		emitBestEffortToolEnd(this.#started, this.#id, this.#name, body, rawBlock, events);
	}

	#reset(): void {
		this.#inside = false;
		this.#id = "";
		this.#name = "";
		this.#started = false;
	}
}

const definition: DialectDefinition = {
	dialect: "hermes",
	prompt: AI_PROMPTS["dialect/hermes"].text,
	createScanner: options => new HermesInbandScanner(options),
	renderToolCall: renderJsonToolCall,
	renderAssistantToolCalls: renderJsonAssistantToolCalls,
	renderToolResults: renderToolResponseResults,
	renderThinking: renderThinkTags,
	renderTranscript: chatMlTranscriptRenderer({
		toolResultRole: "tool",
		renderThinking: renderThinkTags,
		renderCalls: renderJsonAssistantToolCalls,
		renderResultsBody: renderToolResponseResults,
	}),
};

export default definition;
