/**
 * `PresentationEventBridge`: the one place agent events become view-model
 * updates.
 *
 * The bridge is the only module that sees both sides. A renderer never
 * subscribes to the session, and the session never calls a renderer, so
 * neither can grow a dependency on the other's internals.
 *
 * Block identity is the contract that makes the incremental path work: an
 * assistant turn keeps one id from `message_start` to `message_end`, and a tool
 * execution is keyed by its call id, so a stream of updates lands on the block
 * it belongs to instead of appending a new one per event.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import { isRecord } from "@veyyon/utils/type-guards";
import type { PresentationContext, ToolStatus, TranscriptBlock } from "@veyyon/wire/presentation";
import type { AgentSessionEvent } from "../session/agent-session-types";
import { blockIdFor, isDisplayed, toTranscriptBlock, toTranscriptBlocks } from "./transcript-builder";

/** The slice of a session the bridge needs. Anything wider is not its business. */
export interface PresentationEventSource {
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	readonly messages: readonly AgentMessage[];
}

/** Renders a tool's arguments and results for display, with secrets redacted. */
export type ToolTextRenderer = (value: unknown) => string;

function defaultToolText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	try {
		return JSON.stringify(value, null, 2) ?? "";
	} catch {
		return "[unserializable]";
	}
}

/** Flatten an `AgentToolResult` content array to display text. */
function resultText(result: unknown): string {
	if (!isRecord(result)) return "";
	const content = result.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") continue;
		text += text.length > 0 ? `\n${block.text}` : block.text;
	}
	return text;
}

export class PresentationEventBridge {
	#source: PresentationEventSource;
	#presentation: PresentationContext;
	#renderToolText: ToolTextRenderer;
	#unsubscribe: (() => void) | undefined;

	/**
	 * Index assigned to each message the bridge has seen, by object identity.
	 * `message_start` and `message_end` carry the same reference, and the block
	 * id is a function of the index, so the pair must agree on it. Keyed weakly
	 * because a long session's history is the session's to hold, not the
	 * bridge's to pin.
	 */
	#indices = new WeakMap<object, number>();
	#nextIndex = 0;

	/** Tool calls that have started and not yet ended, so a block can report `running`. */
	#runningToolCalls = new Set<string>();

	constructor(source: PresentationEventSource, presentation: PresentationContext, renderToolText?: ToolTextRenderer) {
		this.#source = source;
		this.#presentation = presentation;
		this.#renderToolText = renderToolText ?? defaultToolText;
	}

	/**
	 * Seed the renderer with the session's current transcript, then follow it.
	 * Seeding first is what makes a resumed session and a fresh one take the
	 * same path: the renderer is never handed an incremental update for a
	 * message it has not seen.
	 */
	connect(): void {
		if (this.#unsubscribe !== undefined) return;
		const messages = this.#source.messages;
		for (let i = 0; i < messages.length; i++) {
			const message = messages[i]!;
			if (isRecord(message)) this.#indices.set(message, i);
		}
		this.#nextIndex = messages.length;
		this.#presentation.setTranscriptBlocks(toTranscriptBlocks(messages, { renderToolText: this.#renderToolText }));
		this.#unsubscribe = this.#source.subscribe(event => {
			this.#handle(event);
		});
	}

	disconnect(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#runningToolCalls.clear();
	}

	get connected(): boolean {
		return this.#unsubscribe !== undefined;
	}

	#indexOf(message: AgentMessage): number {
		if (!isRecord(message)) return this.#nextIndex++;
		const known = this.#indices.get(message);
		if (known !== undefined) return known;
		const index = this.#nextIndex++;
		this.#indices.set(message, index);
		return index;
	}

	#blockFor(message: AgentMessage, streaming: boolean): TranscriptBlock {
		return toTranscriptBlock(message, {
			index: this.#indexOf(message),
			streaming,
			pendingToolCallIds: this.#runningToolCalls,
			renderToolText: this.#renderToolText,
		});
	}

	#handle(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start": {
				if (!isDisplayed(event.message)) return;
				this.#presentation.appendTranscriptBlock(this.#blockFor(event.message, true));
				return;
			}
			case "message_update": {
				if (!isDisplayed(event.message)) return;
				const block = this.#blockFor(event.message, true);
				this.#presentation.updateTranscriptBlock(block.id, block);
				return;
			}
			case "message_end": {
				if (!isDisplayed(event.message)) return;
				const block = this.#blockFor(event.message, false);
				this.#presentation.updateTranscriptBlock(block.id, block);
				return;
			}
			case "tool_execution_start": {
				this.#runningToolCalls.add(event.toolCallId);
				this.#presentation.appendTranscriptBlock({
					kind: "tool-execution",
					id: `tool:${event.toolCallId}`,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					status: "running",
					input: this.#renderToolText(event.args),
					timestamp: Date.now(),
				});
				return;
			}
			case "tool_execution_update": {
				this.#presentation.updateTranscriptBlock(`tool:${event.toolCallId}`, {
					output: resultText(event.partialResult),
				});
				return;
			}
			case "tool_execution_end": {
				this.#runningToolCalls.delete(event.toolCallId);
				const failed = event.isError === true || (isRecord(event.result) && event.result.isError === true);
				const status: ToolStatus = failed ? "failed" : "succeeded";
				const text = resultText(event.result);
				this.#presentation.updateTranscriptBlock(
					`tool:${event.toolCallId}`,
					failed ? { status, error: text } : { status, output: text },
				);
				return;
			}
			case "notice": {
				// A notice has no block of its own: it is session state, and the
				// status line is where session state lives. An error notice is the
				// exception — it names a failure the operator must be able to scroll
				// back to, so it enters the transcript as well.
				if (event.level !== "error") return;
				this.#presentation.appendTranscriptBlock({
					kind: "error",
					id: `notice:${this.#nextIndex++}`,
					message: event.message,
					recoverable: true,
					timestamp: Date.now(),
				});
				return;
			}
			default:
				// Every other session event changes the status line, the composer or
				// nothing a renderer draws. Those surfaces are pushed by their own
				// builders on their own cadence, not one view-model per event.
				return;
		}
	}

	/** Test-only seam: which tool calls the bridge currently reports as running. */
	get runningToolCalls(): ReadonlySet<string> {
		return this.#runningToolCalls;
	}

	/** The block id the bridge would assign to a message. Used by hosts that patch a block directly. */
	blockId(message: AgentMessage): string {
		return blockIdFor(message, this.#indexOf(message));
	}
}
