import { emitTextHoldingPartialTag, scanFencedThinking, scanThinkingText, ThinkingSection } from "./coercion";
import { FencedThinkingScanner } from "./fenced-thinking";
import type { InbandScanEvent, InbandScanner } from "./types";
import { THINK_CLOSE, THINK_OPEN, XML_THINKING_CLOSE, XML_THINKING_OPEN } from "./wire-tags";

type Tag = { readonly open: string; readonly close: string; readonly fenced?: boolean };

/**
 * Every dialect's in-band thinking section in its canonical `renderThinking`
 * form (see the sibling `./*.ts` scanners). {@link ThinkingInbandScanner} heals
 * reasoning a model leaked into its visible text channel back into thinking
 * events, whichever dialect idiom the leak used.
 *
 * Plain (attribute-free) delimiters only — matching what `renderThinking`
 * emits and what models leak in practice. Attributed or namespaced XML thinking
 * tags (`<thinking signature="…">`, `antml:thinking`) are recovered by the owned
 * anthropic-dialect parser, not this text-channel healing fallback.
 */
const TAGS: readonly Tag[] = [
	// The first two come from the shared vocabulary rather than being retyped: this scanner heals reasoning that
	// leaked into the visible channel, so it has to look for exactly what `renderThinking` emitted, and a copy
	// here that drifted would leave the leak unhealed with nothing reporting it.
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
	readonly #thinking = new ThinkingSection();
	/** Fence-aware close-matcher while inside a ` ```thinking ` block; undefined otherwise. */
	#fenced: FencedThinkingScanner | undefined;

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
		for (;;) {
			if (this.#fenced) {
				// Run even with an empty buffer so a held partial close flushes on final.
				const { buffer, closed } = scanFencedThinking(this.#fenced, this.#buffer, final, this.#thinking, events);
				this.#buffer = buffer;
				if (!closed) break;
				this.#closeTag = "";
				this.#fenced = undefined;
				continue;
			}
			if (this.#closeTag) {
				// Run even with an empty buffer so a section the stream ends inside closes on final.
				const { buffer, closed } = scanThinkingText(this.#buffer, this.#closeTag, final, this.#thinking, events);
				this.#buffer = buffer;
				if (!closed) break;
				this.#closeTag = "";
				continue;
			}
			if (this.#buffer.length === 0) break;

			const tag = findEarliestOpen(this.#buffer);
			if (!tag) {
				this.#buffer = emitTextHoldingPartialTag(this.#buffer, OPENS, final, events);
				break;
			}
			if (tag.index > 0) events.push({ type: "text", text: this.#buffer.slice(0, tag.index) });
			this.#buffer = this.#buffer.slice(tag.index + tag.open.length);
			this.#closeTag = tag.close;
			if (tag.fenced) this.#fenced = new FencedThinkingScanner();
			this.#thinking.start(events);
		}
		return events;
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
