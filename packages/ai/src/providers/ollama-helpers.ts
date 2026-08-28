import { normalizeOllamaCloudBaseUrl } from "@veyyon/catalog/provider-models/ollama";
import { parseStreamingJson } from "@veyyon/utils/json-parse";
import * as AIError from "../error";
import { getEnvApiKey } from "../stream";
import type { AssistantMessage, Context, Model, StreamFunction } from "../types";
import { clearStreamingPartialJson, kStreamingPartialJson } from "../utils/block-symbols";
import {
	EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE,
	hasVisibleAssistantContent,
	withEmptyCompletionRetry,
} from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import {
	type CapturedHttpErrorResponse,
	captureHttpErrorResponse,
	materializeDumpBody,
	type RawHttpRequestDump,
} from "../utils/http-inspector";
import {
	armPreResponseTimeout,
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
} from "../utils/idle-iterator";
import { fetchProviderWithRetry } from "../utils/provider-fetch";
import {
	getStreamMarkupHealingPattern,
	type HealedToolCall,
	StreamMarkupHealing,
	type StreamMarkupHealingEvent,
} from "../utils/stream-markup-healing";
import { stopReasonForTerminallessEof } from "../utils/terminalless-eof";
import {
	createChatBody,
	createEmptyOutput,
	type InternalToolCallBlock,
	iterateNdjson,
	OLLAMA_RESPONSE_RETRY_POLICY,
	type OllamaChatOptions,
} from "./ollama";

export function endThinkingBlock(stream: AssistantMessageEventStream, output: AssistantMessage, index: number): void {
	const block = output.content[index];
	if (block?.type === "thinking") {
		stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
	}
}

export function endTextBlock(stream: AssistantMessageEventStream, output: AssistantMessage, index: number): void {
	const block = output.content[index];
	if (block?.type === "text") {
		stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
	}
}

export function endToolCallBlock(stream: AssistantMessageEventStream, output: AssistantMessage, index: number): void {
	const block = output.content[index];
	if (block?.type !== "toolCall") {
		return;
	}
	const toolCall = block as InternalToolCallBlock;
	if (toolCall[kStreamingPartialJson]) {
		toolCall.arguments = parseStreamingJson<Record<string, unknown>>(toolCall[kStreamingPartialJson]);
		clearStreamingPartialJson(toolCall);
	}
	stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: output });
}

export function mapDoneReason(
	doneReason: string | undefined,
	output: AssistantMessage,
): AssistantMessage["stopReason"] {
	if (doneReason === "length") {
		return "length";
	}
	if (doneReason === "tool_calls") {
		return "toolUse";
	}
	if (doneReason === undefined && output.content.some(block => block.type === "toolCall")) {
		return "toolUse";
	}
	return "stop";
}

export const OLLAMA_RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

export const streamOllamaOnce = (
	model: Model<"ollama-chat">,
	context: Context,
	options: OllamaChatOptions = {},
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	void (async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		let sawDone = false;
		const output = createEmptyOutput(model);
		let rawRequestDump: RawHttpRequestDump | undefined;
		let wireBodyJson: string | undefined;
		let capturedErrorResponse: CapturedHttpErrorResponse | undefined;
		let activeThinkingIndex: number | undefined;
		let activeTextIndex: number | undefined;
		const activeToolIndices = new Set<number>();
		const streamMarkupHealing = new StreamMarkupHealing({
			pattern: getStreamMarkupHealingPattern(model.provider, model.id),
		});
		let healedToolCallEmitted = false;
		let suppressHealedThinking = false;
		const endActiveTextBlock = (): void => {
			if (activeTextIndex === undefined) return;
			endTextBlock(stream, output, activeTextIndex);
			activeTextIndex = undefined;
		};
		const endActiveThinkingBlock = (): void => {
			if (activeThinkingIndex === undefined) return;
			endThinkingBlock(stream, output, activeThinkingIndex);
			activeThinkingIndex = undefined;
		};
		const appendVisibleText = (text: string): void => {
			if (text.length === 0) return;
			endActiveThinkingBlock();
			if (activeTextIndex === undefined) {
				output.content.push({ type: "text", text: "" });
				activeTextIndex = output.content.length - 1;
				stream.push({ type: "text_start", contentIndex: activeTextIndex, partial: output });
			}
			const block = output.content[activeTextIndex];
			if (block?.type === "text") {
				block.text += text;
				stream.push({
					type: "text_delta",
					contentIndex: activeTextIndex,
					delta: text,
					partial: output,
				});
			}
			if (!firstTokenTime) firstTokenTime = performance.now();
		};
		const appendVisibleThinking = (thinking: string): void => {
			if (thinking.length === 0) return;
			endActiveTextBlock();
			if (activeThinkingIndex === undefined) {
				output.content.push({ type: "thinking", thinking: "" });
				activeThinkingIndex = output.content.length - 1;
				stream.push({ type: "thinking_start", contentIndex: activeThinkingIndex, partial: output });
			}
			const block = output.content[activeThinkingIndex];
			if (block?.type === "thinking") {
				block.thinking += thinking;
				stream.push({
					type: "thinking_delta",
					contentIndex: activeThinkingIndex,
					delta: thinking,
					partial: output,
				});
			}
			if (!firstTokenTime) firstTokenTime = performance.now();
		};
		const emitHealedToolCall = (call: HealedToolCall): void => {
			endActiveThinkingBlock();
			endActiveTextBlock();
			const toolCall: InternalToolCallBlock = {
				type: "toolCall",
				id: call.id,
				name: call.name,
				arguments: parseStreamingJson<Record<string, unknown>>(call.arguments),
				[kStreamingPartialJson]: call.arguments,
			};
			output.content.push(toolCall);
			const index = output.content.length - 1;
			stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
			stream.push({
				type: "toolcall_delta",
				contentIndex: index,
				delta: call.arguments,
				partial: output,
			});
			endToolCallBlock(stream, output, index);
			healedToolCallEmitted = true;
			if (!firstTokenTime) firstTokenTime = performance.now();
		};
		const emitHealingEvent = (event: StreamMarkupHealingEvent): void => {
			if (event.type === "text") {
				appendVisibleText(event.text);
			} else if (event.type === "thinking") {
				if (!suppressHealedThinking) appendVisibleThinking(event.thinking);
			} else {
				emitHealedToolCall(event.call);
			}
		};
		const drainHealedToolCalls = (): void => {
			for (const call of streamMarkupHealing.drainCompleted()) emitHealedToolCall(call);
		};
		try {
			const apiKey = options.apiKey || getEnvApiKey(model.provider);
			if (!apiKey) {
				throw new AIError.MissingApiKeyError(model.provider);
			}
			const baseUrl = normalizeOllamaCloudBaseUrl(model.baseUrl);
			let body = createChatBody(model, context, options);
			const replacementPayload = await options.onPayload?.(body, model);
			if (replacementPayload !== undefined) {
				body = replacementPayload as typeof body;
			}
			rawRequestDump = {
				provider: model.provider,
				api: model.api,
				model: model.id,
				method: "POST",
				url: `${baseUrl}/api/chat`,
			};
			wireBodyJson = JSON.stringify(body);
			const idleTimeoutMs = options.streamIdleTimeoutMs ?? getOpenAIStreamIdleTimeoutMs();
			const firstEventTimeoutMs =
				options.streamFirstEventTimeoutMs ?? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs);
			const watchdog = armPreResponseTimeout(options.signal, firstEventTimeoutMs);
			let response: Response;
			try {
				response = await fetchProviderWithRetry(`${baseUrl}/api/chat`, {
					method: "POST",
					headers: {
						...model.headers,
						...options.headers,
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
					signal: watchdog.signal,
					defaultDelayMs: OLLAMA_RETRY_DELAYS_MS,
					maxDelayMs: options.maxRetryDelayMs,
					retry: OLLAMA_RESPONSE_RETRY_POLICY,
					fetch: options.fetch,
					timeout: false,
				});
			} finally {
				watchdog.clear();
			}
			if (!response.ok) {
				capturedErrorResponse = await captureHttpErrorResponse(response);
				throw new AIError.OllamaApiError(`HTTP ${response.status} from ${baseUrl}/api/chat`, response.status, {
					headers: response.headers,
				});
			}
			if (!response.body) {
				throw new AIError.OllamaApiError("Ollama returned an empty response body", response.status, {
					headers: response.headers,
				});
			}
			stream.push({ type: "start", partial: output });
			for await (const chunk of iterateNdjson(response.body)) {
				if (chunk.message?.thinking) {
					suppressHealedThinking = true;
					endActiveTextBlock();
					if (activeThinkingIndex === undefined) {
						output.content.push({ type: "thinking", thinking: "" });
						activeThinkingIndex = output.content.length - 1;
						stream.push({ type: "thinking_start", contentIndex: activeThinkingIndex, partial: output });
					}
					const block = output.content[activeThinkingIndex];
					if (block?.type === "thinking") {
						block.thinking += chunk.message.thinking;
						stream.push({
							type: "thinking_delta",
							contentIndex: activeThinkingIndex,
							delta: chunk.message.thinking,
							partial: output,
						});
					}
					if (!firstTokenTime) {
						firstTokenTime = performance.now();
					}
				}
				const chunkContent = chunk.message?.content;
				const structuredCalls = chunk.message?.tool_calls?.length ? chunk.message.tool_calls : undefined;
				if (chunkContent) {
					const healingEvents = structuredCalls
						? streamMarkupHealing.feedEventsWithoutCalls(chunkContent)
						: streamMarkupHealing.feedEvents(chunkContent);
					for (const event of healingEvents) {
						emitHealingEvent(event);
					}
				}
				if (structuredCalls) {
					endActiveThinkingBlock();
					endActiveTextBlock();
					for (const call of structuredCalls) {
						const name = call.function?.name ?? "unknown_tool";
						const rawArgs = call.function?.arguments;
						const partialJson = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs ?? {});
						const toolCall: InternalToolCallBlock = {
							type: "toolCall",
							id: `ollama:${output.content.length}:${name}`,
							name,
							arguments: parseStreamingJson<Record<string, unknown>>(partialJson),
							[kStreamingPartialJson]: partialJson,
						};
						output.content.push(toolCall);
						const index = output.content.length - 1;
						activeToolIndices.add(index);
						stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
						stream.push({
							type: "toolcall_delta",
							contentIndex: index,
							delta: partialJson,
							partial: output,
						});
						if (!firstTokenTime) {
							firstTokenTime = performance.now();
						}
					}
				}
				if (chunk.done) {
					sawDone = true;
					for (const event of streamMarkupHealing.flushEvents()) {
						emitHealingEvent(event);
					}
					drainHealedToolCalls();
					endActiveThinkingBlock();
					endActiveTextBlock();
					for (const index of activeToolIndices) {
						endToolCallBlock(stream, output, index);
					}
					activeToolIndices.clear();
					output.stopReason = mapDoneReason(chunk.done_reason, output);
					if (healedToolCallEmitted && output.stopReason === "stop") {
						output.stopReason = "toolUse";
					}
					output.usage.input = chunk.prompt_eval_count ?? 0;
					output.usage.output = chunk.eval_count ?? 0;
					output.usage.totalTokens = output.usage.input + output.usage.output;
				}
			}
			for (const event of streamMarkupHealing.flushEvents()) {
				emitHealingEvent(event);
			}
			drainHealedToolCalls();
			if (healedToolCallEmitted && output.stopReason === "stop") {
				output.stopReason = "toolUse";
			}
			endActiveThinkingBlock();
			endActiveTextBlock();
			if (!sawDone) {
				const stopReason = stopReasonForTerminallessEof(output.content, activeToolIndices.size === 0);
				if (stopReason === undefined) {
					throw new AIError.ProviderResponseError(
						"Ollama stream ended without a done chunk (connection dropped or response truncated)",
						{ provider: model.provider, kind: "incomplete-stream" },
					);
				}
				output.stopReason = stopReason;
			}
			if (output.stopReason === "length" && !hasVisibleAssistantContent(output)) {
				output.stopReason = "error";
				output.errorMessage = EMPTY_OLLAMA_LENGTH_COMPLETION_MESSAGE;
			}
			if (output.stopReason === "stop" && output.content.some(block => block.type === "toolCall")) {
				output.stopReason = "toolUse";
			}
			output.duration = performance.now() - startTime;
			if (firstTokenTime) {
				output.ttft = firstTokenTime - startTime;
			}
			if (output.stopReason === "error") {
				stream.push({ type: "error", reason: "error", error: output });
				stream.end();
				return;
			}
			const doneReason =
				output.stopReason === "length" ? "length" : output.stopReason === "toolUse" ? "toolUse" : "stop";
			stream.push({ type: "done", reason: doneReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if (block.type === "toolCall") {
					clearStreamingPartialJson(block);
				}
			}
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				rawRequestDump: materializeDumpBody(rawRequestDump, wireBodyJson),
				capturedErrorResponse,
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) {
				output.ttft = firstTokenTime - startTime;
			}
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
};

export const streamOllama: StreamFunction<"ollama-chat"> = (model, context, options) =>
	withEmptyCompletionRetry(model, context, options, streamOllamaOnce);
