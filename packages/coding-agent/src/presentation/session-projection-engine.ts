/**
 * `SessionProjectionEngine`: the single source of truth for message indexing, tool argument
 * correlation, retry tracking and transcript block projection, shared between the live terminal
 * controllers and the presentation event bridge so both project one message to one block id.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { isRecord } from "@veyyon/utils/type-guards";
import type { BlockId, TranscriptBlock } from "@veyyon/wire/presentation";
import { formatRetrySummary, type RetryLineInput, type RetryTrace, retryReason } from "../modes/retry-display";
import { buildToolExecutionBlock } from "./tool-execution";
import { blockIdFor, defaultToolText, toTranscriptBlock, toTranscriptBlocks } from "./transcript-builder";

export interface SessionProjectionEngineOptions {
	readonly renderToolText?: (value: unknown) => string;
	readonly getMessages?: () => readonly AgentMessage[];
	readonly retryAttempt?: number;
}

/** Put `id` in `set` when `present`, else take it out. */
function setMembership(set: Set<string>, id: string, present: boolean): void {
	if (present) set.add(id);
	else set.delete(id);
}

export class SessionProjectionEngine {
	#options: SessionProjectionEngineOptions;
	#indices = new WeakMap<object, number>();
	#nextIndex = 0;
	#activeMessageIndices = new Map<AgentMessage["role"], number>();
	#toolArgs = new Map<string, { toolName: string; args: unknown; timestamp: number }>();
	#runningToolCalls = new Set<string>();
	#settledToolCalls = new Set<string>();
	#backgroundTaskCallIds = new Set<string>();
	#retryTrace: RetryTrace | undefined = undefined;

	constructor(options: SessionProjectionEngineOptions = {}) {
		this.#options = options;
	}

	/** Index every message the source holds now, so a live update to one lands on its persisted block. */
	seedMessages(messages: readonly AgentMessage[] = this.#options.getMessages?.() ?? []): void {
		for (let i = 0; i < messages.length; i++) {
			const msg = messages[i]!;
			if (isRecord(msg)) {
				this.#indices.set(msg, i);
			}
		}
		this.#nextIndex = Math.max(this.#nextIndex, messages.length);
	}

	indexOf(message: AgentMessage): number {
		if (!isRecord(message)) return this.#nextIndex++;
		const known = this.#indices.get(message);
		if (known !== undefined) return known;
		const index = this.#nextIndex++;
		this.#indices.set(message, index);
		return index;
	}

	beginMessage(message: AgentMessage): void {
		this.#activeMessageIndices.set(message.role, this.indexOf(message));
	}

	blockId(message: AgentMessage): BlockId {
		return blockIdFor(message, this.indexOf(message));
	}

	nextNoticeIndex(): number {
		return this.#nextIndex++;
	}

	recordToolCall(toolCallId: string, toolName: string, args: unknown, timestamp: number = Date.now()): void {
		this.#toolArgs.set(toolCallId, { toolName, args, timestamp });
	}

	recordAssistantMessageToolCalls(message: AgentMessage): void {
		if (!isRecord(message) || message.role !== "assistant") return;
		const content = (message as AssistantMessage).content;
		if (!Array.isArray(content)) return;
		for (const block of content) {
			if (isRecord(block) && block.type === "toolCall" && typeof block.id === "string") {
				const existing = this.#toolArgs.get(block.id);
				if (existing) {
					if (block.arguments !== undefined && !this.#runningToolCalls.has(block.id)) {
						existing.args = block.arguments;
					}
				} else {
					this.#toolArgs.set(block.id, {
						toolName: block.name,
						args: block.arguments,
						timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
					});
				}
			}
		}
	}

	findToolCallArgs(toolCallId: string, fallbackMessages?: readonly AgentMessage[]): unknown {
		const live = this.#toolArgs.get(toolCallId);
		if (live !== undefined && live.args !== undefined) return live.args;
		const messages = fallbackMessages ?? this.#options.getMessages?.() ?? [];
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (!isRecord(msg) || msg.role !== "assistant") continue;
			const content = (msg as AssistantMessage).content;
			if (!Array.isArray(content)) continue;
			for (const block of content) {
				if (isRecord(block) && block.type === "toolCall" && block.id === toolCallId) {
					return block.arguments;
				}
			}
		}
		return undefined;
	}

	getToolCall(toolCallId: string): { toolName: string; args: unknown; timestamp: number } | undefined {
		return this.#toolArgs.get(toolCallId);
	}

	clearToolCall(toolCallId: string): void {
		this.#toolArgs.delete(toolCallId);
		this.#runningToolCalls.delete(toolCallId);
	}

	markToolCallRunning(toolCallId: string, running: boolean): void {
		setMembership(this.#runningToolCalls, toolCallId, running);
	}

	markToolCallSettled(toolCallId: string): void {
		this.#settledToolCalls.add(toolCallId);
	}

	isToolCallSettled(toolCallId: string): boolean {
		return this.#settledToolCalls.has(toolCallId);
	}

	markBackgroundTask(toolCallId: string, isBackground: boolean): void {
		setMembership(this.#backgroundTaskCallIds, toolCallId, isBackground);
	}

	isBackgroundTask(toolCallId: string): boolean {
		return this.#backgroundTaskCallIds.has(toolCallId);
	}

	get runningToolCalls(): ReadonlySet<string> {
		return this.#runningToolCalls;
	}

	get settledToolCalls(): ReadonlySet<string> {
		return this.#settledToolCalls;
	}

	get backgroundTaskCallIds(): ReadonlySet<string> {
		return this.#backgroundTaskCallIds;
	}

	clearTurnToolState(): void {
		this.#activeMessageIndices.clear();
		this.#runningToolCalls.clear();
		this.#toolArgs.clear();
	}

	recordAutoRetryStart(
		event: Pick<RetryLineInput, "attempt" | "delayMs" | "errorId" | "errorMessage" | "mode">,
	): RetryTrace {
		this.#retryTrace ??= { attempts: 0, totalDelayMs: 0 };
		const trace = this.#retryTrace;
		trace.attempts = event.attempt;
		trace.totalDelayMs += Math.max(0, event.delayMs);
		trace.reason = retryReason(event.errorId, event.errorMessage);
		trace.mode = event.mode;
		return trace;
	}

	recordAutoRetryEnd(event: { success: boolean; attempt?: number; finalError?: string; mode?: RetryTrace["mode"] }): {
		summary?: string;
		error?: string;
	} {
		let summary: string | undefined;
		let error: string | undefined;
		if (event.success) {
			if (this.#retryTrace) {
				summary = formatRetrySummary(this.#retryTrace);
			}
		} else {
			const what = event.mode === "continue" ? "Continuation" : "Retry";
			const attempts = event.attempt === 1 ? "1 attempt" : `${event.attempt} attempts`;
			error = `${what} failed after ${attempts}: ${event.finalError || "Unknown error"}`;
		}
		this.#retryTrace = undefined;
		return { summary, error };
	}

	get retryTrace(): RetryTrace | undefined {
		return this.#retryTrace;
	}

	clearRetryTrace(): void {
		this.#retryTrace = undefined;
	}

	projectMessageBlock(
		message: AgentMessage,
		options?: {
			streaming?: boolean;
			renderToolText?: (value: unknown) => string;
			retryAttempt?: number;
			fallbackMessages?: readonly AgentMessage[];
		},
	): TranscriptBlock {
		const renderToolText = options?.renderToolText ?? this.#options.renderToolText ?? defaultToolText;
		const retryAttempt = options?.retryAttempt ?? this.#options.retryAttempt ?? 0;
		const index = this.#activeMessageIndices.get(message.role) ?? this.indexOf(message);
		this.#indices.set(message, index);
		if (options?.streaming) this.#activeMessageIndices.set(message.role, index);
		else this.#activeMessageIndices.delete(message.role);
		return toTranscriptBlock(message, {
			index,
			streaming: options?.streaming,
			pendingToolCallIds: this.#runningToolCalls,
			renderToolText,
			retryAttempt,
			toolCallArgs: id => this.findToolCallArgs(id, options?.fallbackMessages),
		});
	}

	projectToolExecutionBlock(
		toolCallId: string,
		options: {
			toolName?: string;
			args?: unknown;
			result?: {
				content: Array<{ type: string; text?: string }>;
				details?: unknown;
				isError?: boolean;
			};
			isError?: boolean;
			isPartial?: boolean;
			sealed?: boolean;
			timestamp?: number;
			durationMs?: number;
		},
	): TranscriptBlock {
		const info = this.#toolArgs.get(toolCallId);
		const toolName = options.toolName ?? info?.toolName ?? "unknown";
		const args = options.args !== undefined ? options.args : info?.args;
		const timestamp = options.timestamp ?? info?.timestamp ?? Date.now();
		return buildToolExecutionBlock({
			id: `tool:${toolCallId}`,
			toolCallId,
			toolName,
			args,
			result: options.result,
			isError: options.isError,
			isPartial: options.isPartial,
			sealed: options.sealed,
			durationMs: options.durationMs,
			timestamp,
		});
	}

	projectInitialBlocks(messages: readonly AgentMessage[]): TranscriptBlock[] {
		this.seedMessages(messages);
		return toTranscriptBlocks(messages, {
			renderToolText: this.#options.renderToolText,
			retryAttempt: this.#options.retryAttempt,
			toolCallArgs: id => this.findToolCallArgs(id, messages),
		});
	}

	reset(): void {
		this.#indices = new WeakMap();
		this.#nextIndex = 0;
		this.#activeMessageIndices.clear();
		this.#runningToolCalls.clear();
		this.#toolArgs.clear();
		this.#settledToolCalls.clear();
		this.#backgroundTaskCallIds.clear();
		this.#retryTrace = undefined;
	}
}
