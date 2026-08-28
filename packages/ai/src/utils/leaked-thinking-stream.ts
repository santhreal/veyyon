import type { AssistantMessage, TextContent, ThinkingContent, ToolCall } from "../types";
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

export function wrapLeakedThinkingStream(inner: AssistantMessageEventStream): AssistantMessageEventStream {
	const out = new AssistantMessageEventStream();
	void (async () => {
		try {
			let projector: LeakedThinkingProjector | undefined;
			for await (const event of inner) {
				switch (event.type) {
					case "start":
						projector = new LeakedThinkingProjector(out, event.partial);
						break;
					case "text_delta": {
						projector ??= new LeakedThinkingProjector(out, event.partial);
						const block = event.partial.content[event.contentIndex];
						projector.text(event.delta, block?.type === "text" ? block.textSignature : undefined);
						break;
					}
					case "thinking_delta": {
						projector ??= new LeakedThinkingProjector(out, event.partial);
						const block = event.partial.content[event.contentIndex];
						projector.thinking(event.delta, block?.type === "thinking" ? block.thinkingSignature : undefined);
						break;
					}
					case "toolcall_start": {
						projector ??= new LeakedThinkingProjector(out, event.partial);
						const block = event.partial.content[event.contentIndex];
						projector.toolStart(event.contentIndex, block?.type === "toolCall" ? block : undefined);
						break;
					}
					case "toolcall_delta": {
						const block = event.partial.content[event.contentIndex];
						projector?.toolDelta(event.contentIndex, event.delta, block?.type === "toolCall" ? block : undefined);
						break;
					}
					case "toolcall_end":
						projector?.toolEnd(event.contentIndex, event.toolCall);
						break;
					case "done": {
						projector ??= new LeakedThinkingProjector(out, event.message);
						const content = projector.finish(event.message);
						out.push({ type: "done", reason: event.reason, message: { ...event.message, content } });
						return;
					}
					case "error": {
						projector ??= new LeakedThinkingProjector(out, event.error);
						const content = projector.finish(event.error);
						out.push({ type: "error", reason: event.reason, error: { ...event.error, content } });
						return;
					}
				}
			}
			if (!out.done) {
				const result = await inner.result();
				projector ??= new LeakedThinkingProjector(out, result);
				const content = projector.finish(result);
				out.end({ ...result, content });
			}
		} catch (err) {
			if (!out.done) out.fail(err);
		}
	})();
	return out;
}

type OpenBlock = { index: number } | undefined;

class LeakedThinkingProjector {
	readonly #out: AssistantMessageEventStream;
	readonly #healer = new StreamMarkupHealing({ pattern: "thinking" });
	#partial: AssistantMessage;
	#text: OpenBlock;
	#thinking: OpenBlock;
	#fedLen = 0;
	#lastTextSignature: string | undefined;
	#toolBlocks = new Map<number, { index: number; block: StreamingToolCall }>();

	constructor(out: AssistantMessageEventStream, seed: AssistantMessage) {
		this.#out = out;
		this.#partial = { ...seed, content: [] };
		this.#out.push({ type: "start", partial: this.#partial });
	}

	text(delta: string, signature: string | undefined): void {
		this.#fedLen += delta.length;
		if (signature !== undefined) this.#lastTextSignature = signature;
		this.#apply(this.#healer.feedEvents(delta), this.#lastTextSignature);
	}

	thinking(delta: string, signature: string | undefined): void {
		const index = this.#openThinking();
		const block = this.#partial.content[index] as ThinkingContent;
		block.thinking += delta;
		if (signature !== undefined) block.thinkingSignature = signature;
		this.#out.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.#partial });
	}

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
			this.#toolBlocks.delete(srcIndex);
			return;
		}
		this.#apply(this.#healer.flushEvents(), this.#lastTextSignature);
		this.#closeText();
		this.#closeThinking();
		const block = cloneToolCall(toolCall);
		this.#partial.content.push(block);
		const index = this.#partial.content.length - 1;
		this.#out.push({ type: "toolcall_start", contentIndex: index, partial: this.#partial });
		this.#out.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: this.#partial });
	}

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
