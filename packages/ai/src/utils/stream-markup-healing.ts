/**
 * The scanner layer for leaked chat-template markup, and the owner of which
 * pattern a model needs.
 *
 * Hosted models sometimes leak raw template markup into visible `content`
 * instead of returning structured events. This file holds the incremental feed
 * API ({@link StreamMarkupHealing}) and the never-abstaining gate
 * ({@link getStreamMarkupHealingPattern}). WHICH grammar a model may leak is the
 * catalog's `compat/markup-leaks`, beside the rest of its model identity; tool-call
 * scanning delegates to the same dialect scanners as owned in-band tool calling.
 *
 * Two consumers sit above it: `leaked-thinking-stream.ts` wraps a whole provider
 * stream for the generic thinking case, and a provider calls this directly when
 * it has to combine healing with knowledge only it holds (Ollama suppresses
 * healed thinking once the provider streams native reasoning). `harmony-leak.ts`
 * is not part of this layer: it fuses GPT-5 Harmony channel signals and is gated
 * to `openai-codex`.
 */

import { leakedToolCallGrammar } from "@veyyon/catalog/compat/markup-leaks";
import type { OpenAIStreamMarkupHealingPattern } from "@veyyon/catalog/types";

// Format closing tokens referenced from owning dialects.
import { DSML_TOOL_CALLS_CLOSE_ASCII, DSML_TOOL_CALLS_CLOSE_FULLWIDTH } from "../dialect/deepseek";
import { createInbandScanner } from "../dialect/factory";
import { KIMI_SECTION_END } from "../dialect/kimi";
import { ThinkingInbandScanner } from "../dialect/thinking";
import type { InbandScanEvent, InbandScanner } from "../dialect/types";

export interface HealedToolCall {
	readonly id: string;
	readonly name: string;
	readonly arguments: string;
}

/** The same union as the catalog's `OpenAIStreamMarkupHealingPattern`, which owns it. */
export type StreamMarkupHealingPattern = OpenAIStreamMarkupHealingPattern;

export interface StreamMarkupHealingOptions {
	readonly pattern: StreamMarkupHealingPattern;
}

export type StreamMarkupHealingEvent =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "thinking"; readonly thinking: string }
	| { readonly type: "toolCall"; readonly call: HealedToolCall };

/**
 * State machine that consumes streamed visible text and emits cleaned text,
 * thinking deltas, and reconstructed tool calls.
 *
 * A {@link ThinkingInbandScanner} always heals leaked reasoning idioms
 * (`<think>`, `<thinking>`, ` ```thinking `, Gemma/Harmony channels, …) out of
 * the visible channel. For Kimi / DeepSeek-DSML the provider tool-call grammar
 * runs first and its cleaned text is piped through that thinking healer, so a
 * model can leak tool-call markup and reasoning in the same stream.
 *
 * Feed only one stream channel (usually `delta.content` / `message.content`).
 * Mixing reasoning and visible text into the same instance can corrupt held-back
 * partial tag buffers.
 */
export class StreamMarkupHealing {
	readonly #pattern: StreamMarkupHealingPattern;
	/** Provider tool-call grammar (Kimi tokens / DSML envelope); absent for plain text streams. */
	readonly #toolScanner: InbandScanner | undefined;
	/** Always-on healer for leaked reasoning idioms in the visible text channel. */
	readonly #thinkingScanner = new ThinkingInbandScanner();
	#sectionTerminated = false;
	readonly #completed: HealedToolCall[] = [];

	constructor(options: StreamMarkupHealingOptions) {
		this.#pattern = options.pattern;
		this.#toolScanner =
			options.pattern === "kimi"
				? createInbandScanner("kimi")
				: options.pattern === "dsml"
					? createInbandScanner("xml", { xmlTagset: "dsml" })
					: undefined;
	}

	get pattern(): StreamMarkupHealingPattern {
		return this.#pattern;
	}

	/**
	 * Feed a chunk and return visible text only. Reconstructed tool calls are
	 * stored for {@link drainCompleted}; thinking blocks are intentionally not
	 * returned by this compatibility helper. Use {@link feedEvents} when the caller
	 * needs ordered text/thinking/tool-call events.
	 */
	feed(text: string): string {
		let clean = "";
		for (const event of this.feedEvents(text)) {
			if (event.type === "text") {
				clean += event.text;
			} else if (event.type === "toolCall") {
				this.#completed.push(event.call);
			}
		}
		return clean;
	}

	/** Feed a chunk and return cleaned text/thinking/tool-call events in stream order. */
	feedEvents(text: string): StreamMarkupHealingEvent[] {
		if (text.length === 0) return [];
		this.#markSectionClosed(text);
		if (!this.#toolScanner) return this.#convertScannerEvents(this.#thinkingScanner.feed(text));
		return this.#convertScannerEvents(this.#healThinking(this.#toolScanner.feed(text)));
	}

	/**
	 * Feed a chunk and return cleaned events, excluding synthesized tool calls.
	 * Used when the upstream chunk also carries structured `tool_calls`, keeping
	 * that structured payload as the single source of truth while preserving
	 * adjacent text and thinking events.
	 */
	feedEventsWithoutCalls(text: string): StreamMarkupHealingEvent[] {
		const events = this.feedEvents(text);
		let out: StreamMarkupHealingEvent[] | undefined;
		for (let i = 0; i < events.length; i++) {
			const event = events[i]!;
			if (event.type === "toolCall") {
				out ??= events.slice(0, i);
			} else if (out) {
				out.push(event);
			}
		}
		return out ?? events;
	}

	/** Drain accumulated tool calls from calls to {@link feed}. */
	drainCompleted(): HealedToolCall[] {
		if (this.#completed.length === 0) return [];
		return this.#completed.splice(0, this.#completed.length);
	}

	/**
	 * Flush held-back stream-end fragments as ordered events. Partial tool-call
	 * sections/envelopes are dropped by the delegated scanners; unterminated
	 * thinking blocks are emitted as thinking, matching the previous MiniMax parser
	 * behavior.
	 */
	flushEvents(): StreamMarkupHealingEvent[] {
		const tail = this.#toolScanner ? this.#healThinking(this.#toolScanner.flush()) : [];
		const flushed = this.#thinkingScanner.flush();
		for (let fi = 0; fi < flushed.length; fi++) tail.push(flushed[fi]!);
		return this.#convertScannerEvents(tail);
	}

	/** Flush held-back text only. Reconstructed calls are retained for {@link drainCompleted}. */
	flushPending(): string {
		let clean = "";
		for (const event of this.flushEvents()) {
			if (event.type === "text") {
				clean += event.text;
			} else if (event.type === "toolCall") {
				this.#completed.push(event.call);
			}
		}
		return clean;
	}

	/** True once any configured tool-call section/envelope has fully closed. */
	get sectionClosed(): boolean {
		return this.#sectionTerminated;
	}

	#markSectionClosed(text: string): void {
		if (this.#sectionTerminated || !this.#toolScanner) return;
		if (this.#pattern === "kimi") {
			this.#sectionTerminated = text.includes(KIMI_SECTION_END);
			return;
		}
		this.#sectionTerminated =
			text.includes(DSML_TOOL_CALLS_CLOSE_FULLWIDTH) || text.includes(DSML_TOOL_CALLS_CLOSE_ASCII);
	}

	/**
	 * Re-scan the tool scanner's visible text through the always-on thinking
	 * healer: `text` events are healed for leaked reasoning idioms, while the tool
	 * scanner's own thinking / tool-call events pass through in stream order.
	 */
	#healThinking(toolEvents: readonly InbandScanEvent[]): InbandScanEvent[] {
		const out: InbandScanEvent[] = [];
		for (const event of toolEvents) {
			if (event.type === "text") {
				const fed = this.#thinkingScanner.feed(event.text);
				for (let fi = 0; fi < fed.length; fi++) out.push(fed[fi]!);
			} else out.push(event);
		}
		return out;
	}

	#convertScannerEvents(events: readonly InbandScanEvent[]): StreamMarkupHealingEvent[] {
		const out: StreamMarkupHealingEvent[] = [];
		for (const event of events) {
			switch (event.type) {
				case "text":
					out.push({ type: "text", text: event.text });
					break;
				case "thinkingDelta":
					if (event.delta.length > 0) out.push({ type: "thinking", thinking: event.delta });
					break;
				case "toolEnd":
					out.push({
						type: "toolCall",
						call: {
							id: generateHealedToolCallId(),
							name: event.name,
							arguments: JSON.stringify(event.arguments),
						},
					});
					break;
				case "thinkingStart":
				case "thinkingEnd":
				case "toolStart":
				case "toolArgDelta":
					break;
			}
		}
		return out;
	}
}

function generateHealedToolCallId(): string {
	return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/**
 * Pick the leaked-markup healer for a visible-text stream that always gets one.
 *
 * The tool-call grammar comes from `@veyyon/catalog`'s `leakedToolCallGrammar`, which is where the
 * provider and model-id vocabulary lives; `"thinking"` is the floor rather than an absence, because
 * every pattern runs the generic {@link ThinkingInbandScanner} and a leaked reasoning idiom (a Gemini
 * ` ```thinking ` fence arriving through OpenRouter, say) has to be recovered whatever else the model
 * did or did not leak. A caller that may skip healing entirely asks the catalog detector instead —
 * this one never abstains, and the two lists it used to restate are gone.
 */
export function getStreamMarkupHealingPattern(provider: string, modelId: string): StreamMarkupHealingPattern {
	return leakedToolCallGrammar(provider, modelId) ?? "thinking";
}
