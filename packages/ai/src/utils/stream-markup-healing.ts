import { leakedToolCallGrammar } from "@veyyon/catalog/compat/markup-leaks";

import { DSML_TOOL_CALLS_CLOSE_ASCII, DSML_TOOL_CALLS_CLOSE_FULLWIDTH } from "../dialect/deepseek";
import { createInbandScanner } from "../dialect/factory";
import { KIMI_SECTION_END } from "../dialect/kimi";
import { ThinkingInbandScanner } from "../dialect/thinking";
import type { InbandScanEvent, InbandScanner } from "../dialect/types";

import type {
	HealedToolCall,
	StreamMarkupHealingEvent,
	StreamMarkupHealingOptions,
	StreamMarkupHealingPattern,
} from "./stream-markup-healing-helpers";

export type { HealedToolCall, StreamMarkupHealingEvent };

export class StreamMarkupHealing {
	readonly #pattern: StreamMarkupHealingPattern;
	readonly #toolScanner: InbandScanner | undefined;
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

	feedEvents(text: string): StreamMarkupHealingEvent[] {
		if (text.length === 0) return [];
		this.#markSectionClosed(text);
		if (!this.#toolScanner) return this.#convertScannerEvents(this.#thinkingScanner.feed(text));
		return this.#convertScannerEvents(this.#healThinking(this.#toolScanner.feed(text)));
	}

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

	drainCompleted(): HealedToolCall[] {
		if (this.#completed.length === 0) return [];
		return this.#completed.splice(0, this.#completed.length);
	}

	flushEvents(): StreamMarkupHealingEvent[] {
		const tail = this.#toolScanner ? this.#healThinking(this.#toolScanner.flush()) : [];
		const flushed = this.#thinkingScanner.flush();
		for (let fi = 0; fi < flushed.length; fi++) tail.push(flushed[fi]!);
		return this.#convertScannerEvents(tail);
	}

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

export function getStreamMarkupHealingPattern(provider: string, modelId: string): StreamMarkupHealingPattern {
	return leakedToolCallGrammar(provider, modelId) ?? "thinking";
}
