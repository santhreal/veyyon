import { AI_PROMPTS } from "../prompts/registry";
import {
	emitBestEffortToolEnd,
	emitClosedToolCall,
	mintToolCallId,
	scanOutsideText,
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

const TOOL_START_TAGS = [TOOL_CALL_OPEN] as const;
const START_TAGS = [TOOL_CALL_OPEN, THINK_OPEN] as const;
const COMPLETE_NAME = /^\s*\{\s*"name"\s*:\s*("(?:\\.|[^"\\])*")/;

type State = "outside" | "thinking" | "tool";

class Qwen3InbandScanner implements InbandScanner {
	#buffer = "";
	#state: State = "outside";
	#id = "";
	#name = "";
	#started = false;
	readonly #thinking = new ThinkingSection();
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
		const tags = this.#parseThinking ? START_TAGS : TOOL_START_TAGS;
		const { buffer, tag } = scanOutsideText(this.#buffer, tags, final, events);
		this.#buffer = buffer;
		if (tag === null) return;
		if (tag === THINK_OPEN) {
			this.#state = "thinking";
			this.#thinking.start(events);
			return;
		}

		this.#state = "tool";
		this.#id = mintToolCallId();
		this.#name = "";
		this.#started = false;
	}

	#consumeThinking(final: boolean, events: InbandScanEvent[]): void {
		const { buffer, closed } = scanThinkingText(this.#buffer, THINK_CLOSE, final, this.#thinking, events);
		this.#buffer = buffer;
		if (closed) this.#state = "outside";
	}

	#consumeTool(final: boolean, events: InbandScanEvent[]): void {
		const close = this.#buffer.indexOf(TOOL_CALL_CLOSE);
		const body = close === -1 ? this.#buffer : this.#buffer.slice(0, close);
		if (!this.#started) this.#tryStart(body, events);
		if (close === -1) {
			if (final) {
				// Stream ended with no closing tag. A toolStart already announced here
				// MUST be balanced by a toolEnd, or the downstream projector dispatches
				// the named tool with the empty {} args it seeded on toolStart.
				this.#emitBestEffortEnd(body, `${TOOL_CALL_OPEN}${body}`, events);
				this.#resetTool();
			}
			return;
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
		this.#resetTool();
	}

	#emitBestEffortEnd(body: string, rawBlock: string, events: InbandScanEvent[]): void {
		emitBestEffortToolEnd(this.#started, this.#id, this.#name, body, rawBlock, events);
	}

	#endThinking(events: InbandScanEvent[]): void {
		this.#thinking.end(events);
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

	#resetTool(): void {
		this.#state = "outside";
		this.#id = "";
		this.#name = "";
		this.#started = false;
	}
}

const definition: DialectDefinition = {
	dialect: "qwen3",
	prompt: AI_PROMPTS["dialect/qwen3"].text,
	createScanner: options => new Qwen3InbandScanner(options),
	renderToolCall: renderJsonToolCall,
	renderAssistantToolCalls: renderJsonAssistantToolCalls,
	renderToolResults: renderToolResponseResults,
	renderThinking: renderThinkTags,
	renderTranscript: chatMlTranscriptRenderer({
		toolResultRole: "user",
		renderThinking: renderThinkTags,
		renderCalls: renderJsonAssistantToolCalls,
		renderResultsBody: renderToolResponseResults,
	}),
};

export default definition;
