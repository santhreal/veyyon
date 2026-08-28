import { partialSuffixOverlapAny } from "./coercion";
import { FencedThinkingScanner } from "./fenced-thinking";
import type { InbandScanEvent, InbandScanner } from "./types";
import { THINK_CLOSE, THINK_OPEN, XML_THINKING_CLOSE, XML_THINKING_OPEN } from "./wire-tags";

type Tag = { readonly open: string; readonly close: string; readonly fenced?: boolean };

const TAGS: readonly Tag[] = [
	{ open: THINK_OPEN, close: THINK_CLOSE }, // deepseek, glm, hermes, kimi, qwen3 (and anthropic/minimax/xml)
	{ open: XML_THINKING_OPEN, close: XML_THINKING_CLOSE }, // anthropic, minimax, xml
	{ open: "<scratchpad>", close: "</scratchpad>" }, // anthropic
	{ open: "```thinking\n", close: "```", fenced: true }, // gemini fenced thinking
	{ open: "<|channel>thought\n", close: "<channel|>" }, // gemma reasoning channel
	{ open: "<|start|>assistant<|channel|>analysis<|message|>", close: "<|end|>" }, // harmony analysis (rendered)
	{ open: "<|channel|>analysis<|message|>", close: "<|end|>" }, // harmony analysis (bare leak)
];
const OPENS = TAGS.map(tag => tag.open);

export class ThinkingInbandScanner implements InbandScanner {
	#buffer = "";
	#closeTag = "";
	#thinking = "";
	#fenced: FencedThinkingScanner | undefined;

	feed(text: string): InbandScanEvent[] {
		if (text.length === 0) return [];
		this.#buffer += text;
		return this.#consume(false);
	}

	flush(): InbandScanEvent[] {
		const events = this.#consume(true);
		if (this.#buffer.length === 0) return events;
		if (this.#closeTag) {
			this.#emitThinking(this.#buffer, events);
			events.push({ type: "thinkingEnd", thinking: this.#thinking });
		} else {
			events.push({ type: "text", text: this.#buffer });
		}
		this.#buffer = "";
		this.#closeTag = "";
		return events;
	}

	#consume(final: boolean): InbandScanEvent[] {
		const events: InbandScanEvent[] = [];
		for (;;) {
			if (this.#fenced) {
				const result = this.#fenced.feed(this.#buffer, final);
				this.#buffer = result.closed ? result.rest : "";
				this.#emitThinking(result.thinking, events);
				if (result.closed || final) {
					events.push({ type: "thinkingEnd", thinking: this.#thinking });
					this.#thinking = "";
					this.#closeTag = "";
					this.#fenced = undefined;
				}
				if (this.#fenced) break;
				continue;
			}
			if (this.#buffer.length === 0) break;
			if (this.#closeTag) {
				const close = this.#buffer.indexOf(this.#closeTag);
				if (close === -1) {
					const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, [this.#closeTag]);
					this.#emitThinking(this.#buffer.slice(0, this.#buffer.length - hold), events);
					this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
					break;
				}
				this.#emitThinking(this.#buffer.slice(0, close), events);
				this.#buffer = this.#buffer.slice(close + this.#closeTag.length);
				events.push({ type: "thinkingEnd", thinking: this.#thinking });
				this.#thinking = "";
				this.#closeTag = "";
				continue;
			}

			const tag = findEarliestOpen(this.#buffer);
			if (!tag) {
				const hold = final ? 0 : partialSuffixOverlapAny(this.#buffer, OPENS);
				const emit = this.#buffer.slice(0, this.#buffer.length - hold);
				if (emit.length > 0) events.push({ type: "text", text: emit });
				this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
				break;
			}
			if (tag.index > 0) events.push({ type: "text", text: this.#buffer.slice(0, tag.index) });
			this.#buffer = this.#buffer.slice(tag.index + tag.open.length);
			this.#closeTag = tag.close;
			this.#thinking = "";
			if (tag.fenced) this.#fenced = new FencedThinkingScanner();
			events.push({ type: "thinkingStart" });
		}
		return events;
	}

	#emitThinking(delta: string, events: InbandScanEvent[]): void {
		if (delta.length === 0) return;
		this.#thinking += delta;
		events.push({ type: "thinkingDelta", delta });
	}
}

function findEarliestOpen(buffer: string): (Tag & { index: number }) | undefined {
	let best: (Tag & { index: number }) | undefined;
	for (const tag of TAGS) {
		const index = buffer.indexOf(tag.open);
		if (index !== -1 && (!best || index < best.index)) best = { ...tag, index };
	}
	return best;
}
