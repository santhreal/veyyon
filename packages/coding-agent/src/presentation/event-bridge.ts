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
import type { PresentationContext, TranscriptBlock } from "@veyyon/wire/presentation";
import type { AgentSessionEvent } from "../session/agent-session-types";
import { SessionProjectionEngine } from "./session-projection-engine";
import { defaultToolText, isDisplayed, type TranscriptBuildOptions } from "./transcript-builder";

export type ToolTextRenderer = NonNullable<TranscriptBuildOptions["renderToolText"]>;

/** The slice of a session the bridge needs. Anything wider is not its business. */
export interface PresentationEventSource {
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
	readonly messages: readonly AgentMessage[];
}

export class PresentationEventBridge {
	#source: PresentationEventSource;
	#presentation: PresentationContext;
	#renderToolText: ToolTextRenderer;
	#unsubscribe: (() => void) | undefined;
	#engine: SessionProjectionEngine;
	#appendedBlocks = new Set<string>();

	constructor(source: PresentationEventSource, presentation: PresentationContext, renderToolText?: ToolTextRenderer) {
		this.#source = source;
		this.#presentation = presentation;
		this.#renderToolText = renderToolText ?? defaultToolText;
		this.#engine = new SessionProjectionEngine({
			renderToolText: this.#renderToolText,
			getMessages: () => this.#source.messages,
		});
	}

	/**
	 * Seed the renderer with the session's current transcript, then follow it.
	 * Seeding first is what makes a resumed session and a fresh one take the
	 * same path: the renderer is never handed an incremental update for a
	 * message it has not seen.
	 */
	connect(): void {
		if (this.#unsubscribe !== undefined) return;
		const blocks = this.#engine.projectInitialBlocks(this.#source.messages);
		this.#presentation.setTranscriptBlocks(blocks);
		for (const block of blocks) {
			this.#appendedBlocks.add(block.id);
		}
		this.#unsubscribe = this.#source.subscribe(event => {
			this.#handleEvent(event);
		});
	}

	#upsert(block: TranscriptBlock): void {
		if (this.#appendedBlocks.has(block.id)) {
			this.#presentation.updateTranscriptBlock(block.id, block);
		} else {
			this.#appendedBlocks.add(block.id);
			this.#presentation.appendTranscriptBlock(block);
		}
	}

	#handleEvent(event: AgentSessionEvent): void {
		switch (event.type) {
			case "message_start":
			case "message_update":
			case "message_end": {
				if (!isDisplayed(event.message)) return;
				this.#engine.recordAssistantMessageToolCalls(event.message);
				if (event.type === "message_start") this.#engine.beginMessage(event.message);
				this.#upsert(this.#engine.projectMessageBlock(event.message, { streaming: event.type !== "message_end" }));
				if (event.type === "message_end" && isRecord(event.message) && event.message.role === "toolResult") {
					const toolCallId = typeof event.message.toolCallId === "string" ? event.message.toolCallId : undefined;
					if (toolCallId !== undefined) {
						this.#engine.clearToolCall(toolCallId);
					}
				}
				return;
			}
			case "tool_execution_start": {
				const now = Date.now();
				this.#engine.markToolCallRunning(event.toolCallId, true);
				this.#engine.recordToolCall(event.toolCallId, event.toolName, event.args, now);
				const block = this.#engine.projectToolExecutionBlock(event.toolCallId, {
					toolName: event.toolName,
					args: event.args,
					isPartial: true,
					timestamp: now,
				});
				this.#upsert(block);
				return;
			}
			case "tool_execution_update": {
				const info = this.#engine.getToolCall(event.toolCallId);
				const partial = isRecord(event.partialResult)
					? (event.partialResult as {
							content: Array<{ type: string; text?: string }>;
							details?: unknown;
							isError?: boolean;
						})
					: undefined;
				const block = this.#engine.projectToolExecutionBlock(event.toolCallId, {
					toolName: info?.toolName ?? "unknown",
					args: info?.args,
					result: partial,
					isPartial: true,
					timestamp: info?.timestamp ?? Date.now(),
				});
				this.#presentation.updateTranscriptBlock(`tool:${event.toolCallId}`, block);
				return;
			}
			case "tool_execution_end": {
				this.#engine.markToolCallRunning(event.toolCallId, false);
				const info = this.#engine.getToolCall(event.toolCallId);
				const result = isRecord(event.result)
					? (event.result as {
							content: Array<{ type: string; text?: string }>;
							details?: unknown;
							isError?: boolean;
						})
					: undefined;
				const isError = event.isError === true || result?.isError === true;
				const block = this.#engine.projectToolExecutionBlock(event.toolCallId, {
					toolName: info?.toolName ?? event.toolName ?? "unknown",
					args: info?.args,
					result: result ?? (isError ? { content: [], isError: true } : undefined),
					isError,
					isPartial: false,
					sealed: true,
					timestamp: info?.timestamp ?? Date.now(),
				});
				this.#presentation.updateTranscriptBlock(`tool:${event.toolCallId}`, block);
				return;
			}
			case "notice": {
				if (event.level !== "error") return;
				const block: TranscriptBlock = {
					kind: "error",
					id: `notice:${this.#engine.nextNoticeIndex()}`,
					message: event.source ? `${event.source}: ${event.message}` : event.message,
					recoverable: true,
					timestamp: Date.now(),
				};
				this.#upsert(block);
				return;
			}
			case "auto_retry_start": {
				this.#engine.recordAutoRetryStart(event);
				return;
			}
			case "auto_retry_end": {
				this.#engine.recordAutoRetryEnd(event);
				return;
			}
			case "agent_end":
			case "turn_end": {
				this.#engine.clearTurnToolState();
				return;
			}
			default:
				return;
		}
	}

	disconnect(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
		this.#appendedBlocks.clear();
		this.#engine.reset();
	}

	get connected(): boolean {
		return this.#unsubscribe !== undefined;
	}

	/** Test-only seam: which tool calls the bridge currently reports as running. */
	get runningToolCalls(): ReadonlySet<string> {
		return this.#engine.runningToolCalls;
	}

	/** The block id the bridge would assign to a message. Used by hosts that patch a block directly. */
	blockId(message: AgentMessage): string {
		return this.#engine.blockId(message);
	}
}
