/**
 * The stream-wrapping layer over the leaked-markup scanner, for reasoning only.
 *
 * Some providers emit their canonical reasoning idioms (` ```thinking `,
 * `<think>`, Gemma/Harmony channels, …) into the *visible* text stream instead
 * of a structured thinking part. {@link wrapLeakedThinkingStream} re-projects a
 * provider stream into a fresh {@link AssistantMessageEventStream}, splitting the
 * leaked fences out into proper `thinking` blocks *live* as deltas arrive. Which
 * pattern a model needs is not decided here: `stream-markup-healing.ts` owns
 * that, and a provider that needs to heal inline calls it directly instead of
 * being wrapped.
 *
 * Applied to every provider stream *except* official first-party endpoints
 * (the official Anthropic API and the official OpenAI / OpenAI-Codex endpoints),
 * which return structured thinking and never leak — `healLeakedThinking` in
 * `../stream.ts` gates the wrap so the healer cannot misfire on legitimate
 * fenced content those models emit as visible text.
 *
 * The healing is idempotent: a second pass over already-clean text finds no
 * fences, so wrapping a provider that already heals (or wrapping twice) is a
 * harmless pass-through. Signatures are load-bearing for Google/Gemini/Vertex
 * thought round-tripping, so text sub-blocks carry the source `textSignature`,
 * forwarded thinking blocks their `thinkingSignature`, and forwarded tool calls
 * their `thoughtSignature`.
 *
 * Modeled on {@link wrapInbandToolStream} / `InbandStreamProjector` in
 * `../dialect/owned-stream.ts`, minus all in-band tool-call grammar: tool-call
 * events are forwarded verbatim.
 */

import type { AssistantMessage, AssistantMessageEvent, TextContent, ThinkingContent, ToolCall } from "../types";
import {
	clearStreamingPartialJson,
	getStreamingPartialJson,
	type StreamingPartialJsonCarrier,
	setStreamingPartialJson,
} from "./block-symbols";
import { AssistantMessageEventStream } from "./event-stream";
import { StreamMarkupHealing, type StreamMarkupHealingEvent } from "./stream-markup-healing";

type StreamingToolCall = ToolCall & StreamingPartialJsonCarrier;

function cloneToolCall(source: StreamingToolCall): StreamingToolCall {
	const block: StreamingToolCall = { ...source, arguments: source.arguments };
	const partialJson = getStreamingPartialJson(source);
	if (partialJson !== undefined) setStreamingPartialJson(block, partialJson);
	return block;
}

function syncToolCall(target: StreamingToolCall, source: StreamingToolCall): void {
	Object.assign(target, source);
	const partialJson = getStreamingPartialJson(source);
	if (partialJson === undefined) clearStreamingPartialJson(target);
	else setStreamingPartialJson(target, partialJson);
}

/**
 * Wrap a provider stream so leaked reasoning fences are healed into thinking
 * blocks live, for every provider. Returns a new stream that re-projects the
 * inner one; the inner stream is fully consumed.
 */
export function wrapLeakedThinkingStream(inner: AssistantMessageEventStream): AssistantMessageEventStream {
	const out = new AssistantMessageEventStream();
	void new LeakedThinkingRelay(inner, out).run();
	return out;
}

/** Consumes the inner stream and feeds each event to one {@link LeakedThinkingProjector}. */
class LeakedThinkingRelay {
	readonly #inner: AssistantMessageEventStream;
	readonly #out: AssistantMessageEventStream;
	#projector: LeakedThinkingProjector | undefined;

	constructor(inner: AssistantMessageEventStream, out: AssistantMessageEventStream) {
		this.#inner = inner;
		this.#out = out;
	}

	async run(): Promise<void> {
		try {
			for await (const event of this.#inner) {
				if (this.#relay(event)) return;
			}
			// Inner ended via end(result) without a terminal event.
			if (!this.#out.done) {
				const result = await this.#inner.result();
				this.#out.end({ ...result, content: this.#projectorFor(result).finish(result) });
			}
		} catch (err) {
			if (!this.#out.done) this.#out.fail(err);
		}
	}

	#projectorFor(partial: AssistantMessage): LeakedThinkingProjector {
		this.#projector ??= new LeakedThinkingProjector(this.#out, partial);
		return this.#projector;
	}

	/**
	 * Forwards one inner event and reports whether it ended the stream. `text_start`, `text_end`,
	 * `thinking_start` and `thinking_end` are dropped: the projector emits its own block boundaries
	 * (as `wrapInbandToolStream` does).
	 */
	#relay(event: AssistantMessageEvent): boolean {
		switch (event.type) {
			case "start":
				this.#projector = new LeakedThinkingProjector(this.#out, event.partial);
				return false;
			case "text_delta": {
				const block = event.partial.content[event.contentIndex];
				const signature = block?.type === "text" ? block.textSignature : undefined;
				this.#projectorFor(event.partial).text(event.delta, signature);
				return false;
			}
			case "thinking_delta": {
				const block = event.partial.content[event.contentIndex];
				const signature = block?.type === "thinking" ? block.thinkingSignature : undefined;
				this.#projectorFor(event.partial).thinking(event.delta, signature);
				return false;
			}
			case "toolcall_start": {
				const block = event.partial.content[event.contentIndex];
				this.#projectorFor(event.partial).toolStart(
					event.contentIndex,
					block?.type === "toolCall" ? block : undefined,
				);
				return false;
			}
			case "toolcall_delta": {
				const block = event.partial.content[event.contentIndex];
				this.#projector?.toolDelta(event.contentIndex, event.delta, block?.type === "toolCall" ? block : undefined);
				return false;
			}
			case "toolcall_end":
				this.#projector?.toolEnd(event.contentIndex, event.toolCall);
				return false;
			case "done": {
				const content = this.#projectorFor(event.message).finish(event.message);
				this.#out.push({ type: "done", reason: event.reason, message: { ...event.message, content } });
				return true;
			}
			case "error": {
				const content = this.#projectorFor(event.error).finish(event.error);
				this.#out.push({ type: "error", reason: event.reason, error: { ...event.error, content } });
				return true;
			}
			default:
				return false;
		}
	}
}

type OpenBlock = { index: number } | undefined;

/**
 * Re-projects an inner stream's events into `out`, healing leaked reasoning out
 * of the visible text channel while forwarding native thinking and tool calls.
 */
class LeakedThinkingProjector {
	readonly #out: AssistantMessageEventStream;
	readonly #healer = new StreamMarkupHealing({ pattern: "thinking" });
	#partial: AssistantMessage;
	#text: OpenBlock;
	#thinking: OpenBlock;
	/** Total visible text length fed to the healer, to replay any un-streamed tail in {@link finish}. */
	#fedLen = 0;
	/** Latest non-undefined text signature seen, stamped onto held-back text flushed later. */
	#lastTextSignature: string | undefined;
	/** Forwarded native tool calls, keyed by the inner stream's `contentIndex`. */
	#toolBlocks = new Map<number, { index: number; block: StreamingToolCall }>();

	constructor(out: AssistantMessageEventStream, seed: AssistantMessage) {
		this.#out = out;
		this.#partial = { ...seed, content: [] };
		this.#out.push({ type: "start", partial: this.#partial });
	}

	/** Feed a visible-text delta through the healer, splitting leaked fences live. */
	text(delta: string, signature: string | undefined): void {
		this.#fedLen += delta.length;
		if (signature !== undefined) this.#lastTextSignature = signature;
		this.#apply(this.#healer.feedEvents(delta), this.#lastTextSignature);
	}

	/** Forward a native thinking delta, preserving its signature. */
	thinking(delta: string, signature: string | undefined): void {
		const index = this.#openThinking();
		const block = this.#partial.content[index] as ThinkingContent;
		block.thinking += delta;
		if (signature !== undefined) block.thinkingSignature = signature;
		this.#out.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.#partial });
	}

	/** Forward a native tool call's start, releasing any held-back text first. */
	toolStart(srcIndex: number, source: StreamingToolCall | undefined): void {
		if (!source) return;
		this.#apply(this.#healer.flushEvents(), this.#lastTextSignature);
		this.#closeText();
		this.#closeThinking();
		const block = cloneToolCall(source);
		this.#partial.content.push(block);
		const index = this.#partial.content.length - 1;
		this.#toolBlocks.set(srcIndex, { index, block });
		this.#out.push({ type: "toolcall_start", contentIndex: index, partial: this.#partial });
	}

	toolDelta(srcIndex: number, delta: string, source: StreamingToolCall | undefined): void {
		let entry = this.#toolBlocks.get(srcIndex);
		if (!entry && source) {
			this.toolStart(srcIndex, source);
			entry = this.#toolBlocks.get(srcIndex);
		}
		if (!entry) return;
		if (source) syncToolCall(entry.block, source);
		this.#out.push({ type: "toolcall_delta", contentIndex: entry.index, delta, partial: this.#partial });
	}

	/**
	 * Forward a tool call's end. The entry outlives it: Cursor ends an exec-channel block when the
	 * tool starts and again when the server reports it completed, and a second end that found no
	 * entry was projected as a new block, so every such call was stored twice and the copy never
	 * received a result.
	 */
	toolEnd(srcIndex: number, toolCall: ToolCall): void {
		const entry = this.#toolBlocks.get(srcIndex);
		if (entry) {
			syncToolCall(entry.block, toolCall);
			this.#out.push({
				type: "toolcall_end",
				contentIndex: entry.index,
				toolCall: entry.block,
				partial: this.#partial,
			});
			return;
		}
		// `end` without a matching `start` — release held text, then forward whole.
		this.#apply(this.#healer.flushEvents(), this.#lastTextSignature);
		this.#closeText();
		this.#closeThinking();
		const block = cloneToolCall(toolCall);
		this.#partial.content.push(block);
		const index = this.#partial.content.length - 1;
		this.#toolBlocks.set(srcIndex, { index, block });
		this.#out.push({ type: "toolcall_start", contentIndex: index, partial: this.#partial });
		this.#out.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: this.#partial });
	}

	/**
	 * Finalize: replay any un-streamed visible-text tail from `message.content`,
	 * flush held-back fragments, close open blocks, and return the healed content.
	 */
	finish(message: AssistantMessage): AssistantMessage["content"] {
		let fullText = "";
		let tailSignature: string | undefined;
		for (const block of message.content) {
			if (block.type === "text") {
				fullText += block.text;
				tailSignature = block.textSignature;
			}
		}
		if (tailSignature !== undefined) this.#lastTextSignature = tailSignature;
		if (fullText.length > this.#fedLen) {
			this.#apply(this.#healer.feedEvents(fullText.slice(this.#fedLen)), this.#lastTextSignature);
		}
		this.#apply(this.#healer.flushEvents(), this.#lastTextSignature);
		this.#closeText();
		this.#closeThinking();
		return this.#partial.content;
	}

	#apply(events: readonly StreamMarkupHealingEvent[], signature?: string): void {
		for (const event of events) {
			if (event.type === "text") this.#emitText(event.text, signature);
			else if (event.type === "thinking") this.#emitHealedThinking(event.thinking);
		}
	}

	#emitText(text: string, signature: string | undefined): void {
		if (text.length === 0) return;
		this.#closeThinking();
		if (!this.#text) {
			const block: TextContent =
				signature === undefined ? { type: "text", text: "" } : { type: "text", text: "", textSignature: signature };
			this.#partial.content.push(block);
			this.#text = { index: this.#partial.content.length - 1 };
			this.#out.push({ type: "text_start", contentIndex: this.#text.index, partial: this.#partial });
		} else if (signature !== undefined) {
			(this.#partial.content[this.#text.index] as TextContent).textSignature = signature;
		}
		const block = this.#partial.content[this.#text.index] as TextContent;
		block.text += text;
		this.#out.push({ type: "text_delta", contentIndex: this.#text.index, delta: text, partial: this.#partial });
	}

	/** Healed (leaked) thinking carries no signature, matching the source fence. */
	#emitHealedThinking(text: string): void {
		if (text.length === 0) return;
		const index = this.#openThinking();
		const block = this.#partial.content[index] as ThinkingContent;
		block.thinking += text;
		this.#out.push({ type: "thinking_delta", contentIndex: index, delta: text, partial: this.#partial });
	}

	#openThinking(): number {
		this.#closeText();
		if (!this.#thinking) {
			this.#partial.content.push({ type: "thinking", thinking: "" });
			this.#thinking = { index: this.#partial.content.length - 1 };
			this.#out.push({ type: "thinking_start", contentIndex: this.#thinking.index, partial: this.#partial });
		}
		return this.#thinking.index;
	}

	#closeText(): void {
		if (!this.#text) return;
		const block = this.#partial.content[this.#text.index] as TextContent;
		this.#out.push({ type: "text_end", contentIndex: this.#text.index, content: block.text, partial: this.#partial });
		this.#text = undefined;
	}

	#closeThinking(): void {
		if (!this.#thinking) return;
		const block = this.#partial.content[this.#thinking.index] as ThinkingContent;
		this.#out.push({
			type: "thinking_end",
			contentIndex: this.#thinking.index,
			content: block.thinking,
			partial: this.#partial,
		});
		this.#thinking = undefined;
	}
}
