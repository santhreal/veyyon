import {
	BlockBody,
	emitBestEffortToolEnd,
	emitClosedToolCall,
	mintToolCallId,
	scanOutsideText,
	scanThinkingText,
	ThinkingSection,
} from "./coercion";
import type { InbandScanEvent, InbandScanner } from "./types";
import { THINK_CLOSE, THINK_OPEN, TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from "./wire-tags";

const TOOL_START_TAGS = [TOOL_CALL_OPEN] as const;
const START_TAGS = [TOOL_CALL_OPEN, THINK_OPEN] as const;
/** A body whose first key is `"name"` and whose name string has closed. */
const COMPLETE_NAME = /^\s*\{\s*"name"\s*:\s*("(?:\\.|[^"\\])*")/;
/** A body {@link COMPLETE_NAME} may still match once more of it arrives: a proper prefix of a match. */
const PENDING_NAME = /^\s*(?:\{\s*(?:"(?:n(?:a(?:m(?:e(?:"\s*(?::\s*(?:"(?:\\.|[^"\\])*\\?)?)?)?)?)?)?)?)?)?$/;

type State = "outside" | "thinking" | "tool";

/**
 * The in-band scanner for dialects that carry a call as a `{"name", "arguments"}` JSON body inside
 * `<tool_call>` tags and reasoning inside `<think>` tags: Hermes and Qwen3.
 *
 * A call is announced with `toolStart` once its name string has closed, so the announced name is the
 * name the call ends with. A body that names the call after its arguments is announced when its
 * closing tag arrives.
 */
export class JsonToolCallScanner implements InbandScanner {
	#buffer = "";
	#state: State = "outside";
	#id = "";
	#name = "";
	#started = false;
	/** Whether the body may still name the call at its start, so {@link COMPLETE_NAME} is still worth testing. */
	#nameMayFollow = false;
	#body = new BlockBody(TOOL_CALL_CLOSE);
	readonly #thinking = new ThinkingSection();
	readonly #startTags: readonly string[];

	constructor(parseThinking: boolean) {
		this.#startTags = parseThinking ? START_TAGS : TOOL_START_TAGS;
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
			const state = this.#state;
			if (state === "outside") this.#consumeOutside(final, events);
			else if (state === "thinking") this.#consumeThinking(final, events);
			else this.#consumeTool(final, events);
			if (this.#state === state) break;
		}
		// The tool state hands its body to #body, so the stream can end with the buffer empty inside a block: a
		// block cut off by the stream's end is still ended, and one cut off right after its opener is emitted as the
		// opener text it was. A thinking section is closed.
		if (final && this.#state === "tool") this.#consumeTool(final, events);
		if (final && this.#state === "thinking") {
			this.#thinking.end(events);
			this.#state = "outside";
		}
		return events;
	}

	#consumeOutside(final: boolean, events: InbandScanEvent[]): void {
		const { buffer, tag } = scanOutsideText(this.#buffer, this.#startTags, final, events);
		this.#buffer = buffer;
		if (tag === null) return;
		if (tag === THINK_OPEN) {
			this.#state = "thinking";
			this.#thinking.start(events);
			return;
		}
		this.#state = "tool";
		this.#id = mintToolCallId();
		this.#body = new BlockBody(TOOL_CALL_CLOSE);
		this.#nameMayFollow = true;
	}

	#consumeThinking(final: boolean, events: InbandScanEvent[]): void {
		const { buffer, closed } = scanThinkingText(this.#buffer, THINK_CLOSE, final, this.#thinking, events);
		this.#buffer = buffer;
		if (closed) this.#state = "outside";
	}

	#consumeTool(final: boolean, events: InbandScanEvent[]): void {
		this.#buffer = this.#body.read(this.#buffer, final);
		if (this.#nameMayFollow) this.#tryStart(this.#body.text, events);
		if (this.#body.closed) {
			const body = this.#body.text;
			this.#endTool(body, `${TOOL_CALL_OPEN}${body}${TOOL_CALL_CLOSE}`, true, events);
			return;
		}
		if (!final) return;
		// Stream ended with no closing tag. A toolStart already announced here MUST be balanced by
		// a toolEnd, or the downstream projector dispatches the named tool with the empty {} args
		// it seeded on toolStart.
		const body = this.#body.text;
		this.#endTool(body, `${TOOL_CALL_OPEN}${body}`, false, events);
	}

	/** Completes the block, closed or cut off by the stream's end; a block that yields no call is emitted as the text it was. */
	#endTool(body: string, rawBlock: string, closed: boolean, events: InbandScanEvent[]): void {
		const emitted = events.length;
		if (closed) emitClosedToolCall(this.#started, this.#id, this.#name, body, rawBlock, events);
		else emitBestEffortToolEnd(this.#started, this.#id, this.#name, body, rawBlock, events, true);
		if (events.length === emitted) events.push({ type: "text", text: rawBlock });
		this.#resetTool();
	}

	/** Announces the call once its body has named it; stops testing once the body's start rules a name out. */
	#tryStart(body: string, events: InbandScanEvent[]): void {
		const nameMatch = COMPLETE_NAME.exec(body);
		if (!nameMatch) {
			this.#nameMayFollow = PENDING_NAME.test(body);
			return;
		}
		// The match is anchored and its name string has closed, so later text cannot change it.
		this.#nameMayFollow = false;
		let name: unknown;
		try {
			name = JSON.parse(nameMatch[1]!);
		} catch {
			return;
		}
		if (typeof name !== "string" || name.length === 0) return;
		this.#name = name;
		this.#started = true;
		events.push({ type: "toolStart", id: this.#id, name });
	}

	#resetTool(): void {
		this.#state = "outside";
		this.#id = "";
		this.#name = "";
		this.#started = false;
		this.#nameMayFollow = false;
	}
}
