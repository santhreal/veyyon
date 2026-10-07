/**
 * Streaming half of the auth-gateway's OpenAI Responses bridge: veyyon's
 * {@link AssistantMessageEventStream} written as the documented `response.*` SSE taxonomy.
 *
 * Spec: https://platform.openai.com/docs/api-reference/responses-streaming
 */

import { errorMessage } from "@veyyon/utils/type-guards";
import type { AuthGatewayParsedRequest, AuthGatewayStreamControl } from "../auth-gateway/types";
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream, ToolCall } from "../types";
import {
	buildOutputItems,
	buildUsage,
	customToolCallItem,
	failedMessageError,
	functionCallItem,
	type MessageSignature,
	makeCustomCallId,
	makeFuncCallId,
	makeMsgId,
	makeReasoningId,
	makeRespId,
	type OutputItem,
	type OutputText,
	type ResponseStatus,
	reasoningItemId,
	responseEnvelope,
	responseStatusForStopReason,
	sameMessageSignature,
	wireCallId,
} from "./openai-responses-server-output";
import { parseTextSignature } from "./openai-shared";

interface OpenMessage {
	kind: "message";
	itemId: string;
	outputIndex: number;
	contentIndex: number;
	currentPartText: string;
	content: OutputText[];
	signature?: MessageSignature;
}
interface OpenReasoning {
	kind: "reasoning";
	itemId: string;
	outputIndex: number;
	reasoningText: string;
}
interface OpenFunctionCall {
	kind: "function_call";
	itemId: string;
	outputIndex: number;
	contentIndex: number;
	callId: string;
	name: string;
	argsText: string;
	/** Set when the underlying ToolCall is a custom-tool emission. */
	customWireName?: string;
}
type OpenItem = OpenMessage | OpenReasoning | OpenFunctionCall;

const TERMINAL_EVENT: Record<ResponseStatus, string> = {
	completed: "response.completed",
	in_progress: "response.completed",
	incomplete: "response.incomplete",
	failed: "response.failed",
};

function sseEvent(name: string, data: unknown): string {
	return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Where the writer's frames go. `cancelled` silences every frame but the terminal one. */
interface FrameSink {
	readonly cancelled: boolean;
	enqueue(frame: string): void;
}

/**
 * The SSE frames for one response. {@link apply} takes the events in stream order; {@link finish}
 * or {@link fail} writes the terminal event and `[DONE]`.
 *
 * At most one message or reasoning item is open at a time. Tool calls stay open per content index,
 * so parallel calls whose events interleave each write to their own item.
 */
class ResponsesStreamWriter {
	readonly #sink: FrameSink;
	readonly #responseId: string;
	readonly #model: string;
	#sequence = 0;
	#createdAt = Math.floor(Date.now() / 1000);
	#outputIndex = 0;
	#open: OpenItem | null = null;
	readonly #openCalls = new Map<number, OpenFunctionCall>();
	readonly #finished: OutputItem[] = [];
	#final: AssistantMessage | undefined;
	#failure: AssistantMessage | undefined;

	constructor(sink: FrameSink, responseId: string, model: string) {
		this.#sink = sink;
		this.#responseId = responseId;
		this.#model = model;
	}

	apply(ev: AssistantMessageEvent): void {
		switch (ev.type) {
			case "start":
				return this.#start(ev.partial);
			case "text_start":
				return this.#textStart(ev.partial, ev.contentIndex);
			case "text_delta":
				return this.#textDelta(ev.delta);
			case "text_end":
				return this.#textEnd(ev.content);
			case "thinking_start":
				return this.#thinkingStart(ev.partial, ev.contentIndex);
			case "thinking_delta":
				return this.#thinkingDelta(ev.delta);
			case "thinking_end":
				return this.#thinkingEnd(ev.content);
			case "toolcall_start":
				return this.#toolCallStart(ev.partial, ev.contentIndex);
			case "toolcall_delta":
				return this.#toolCallDelta(ev.contentIndex, ev.delta);
			case "toolcall_end":
				return this.#toolCallEnd(ev.contentIndex, ev.toolCall);
			case "done":
				this.#final = ev.message;
				return;
			case "error":
				this.#failure = ev.error;
				return;
		}
	}

	/**
	 * Close every open item and write the terminal event: `response.failed` for an `error` event, a
	 * rejected result or a stream that ended without a final message, and otherwise the event the
	 * final message's stop reason selects, carrying the items built from that message.
	 */
	async finish(events: AssistantMessageEventStream): Promise<void> {
		for (const call of Array.from(this.#openCalls.values())) this.#closeCall(call);
		this.#closeOpen();
		if (this.#failure) return this.#failWith(this.#failure.errorMessage ?? "stream failed");
		// A stream that produced no `done` event is asked for its result, and a rejection there is a
		// failure like any other: a generation that failed after emitting some text must not reach the
		// client as a completed response with partial content.
		let resultFailure: string | undefined;
		const message =
			this.#final ??
			((await events.result().catch((error: unknown) => {
				resultFailure = errorMessage(error);
				return null;
			})) as AssistantMessage | null);
		if (!message) return this.#failWith(resultFailure ?? "stream ended without a final message");
		// Build the canonical output from the final message so non-streaming
		// readers see the exact same shape they'd get from encodeResponse().
		const output = buildOutputItems(message);
		const usage = buildUsage(message);
		const status = responseStatusForStopReason(message);
		this.#terminal(
			TERMINAL_EVENT[status],
			responseEnvelope({
				id: this.#responseId,
				createdAt: this.#createdAt,
				status,
				model: this.#model,
				output,
				usage,
				error: failedMessageError(message, status),
			}),
		);
	}

	/** The stream itself threw: report the error with no items. */
	fail(error: unknown): void {
		this.#terminal("response.failed", {
			id: this.#responseId,
			object: "response",
			created_at: Math.floor(Date.now() / 1000),
			status: "failed",
			model: this.#model,
			output: [],
			error: { message: errorMessage(error) },
			incomplete_details: null,
		});
	}

	#failWith(message: string): void {
		this.#terminal(
			"response.failed",
			responseEnvelope({
				id: this.#responseId,
				createdAt: this.#createdAt,
				status: "failed",
				model: this.#model,
				output: this.#finished,
				usage: null,
				error: message,
			}),
		);
	}

	#emit(name: string, data: Record<string, unknown>): void {
		if (this.#sink.cancelled) return;
		this.#sink.enqueue(sseEvent(name, { type: name, sequence_number: this.#sequence++, ...data }));
	}

	#terminal(name: string, response: Record<string, unknown>): void {
		this.#sink.enqueue(sseEvent(name, { type: name, sequence_number: this.#sequence++, response }));
		if (!this.#sink.cancelled) this.#sink.enqueue("data: [DONE]\n\n");
	}

	#snapshot(): Record<string, unknown> {
		return responseEnvelope({
			id: this.#responseId,
			createdAt: this.#createdAt,
			status: "in_progress",
			model: this.#model,
			output: [],
			usage: null,
		});
	}

	#start(partial: AssistantMessage): void {
		this.#createdAt = Math.floor((partial.timestamp || Date.now()) / 1000);
		this.#emit("response.created", { response: this.#snapshot() });
		// Mirrors real OpenAI; some clients gate on it before reading items.
		this.#emit("response.in_progress", { response: this.#snapshot() });
	}

	/** Close the open message or reasoning item before another one opens. An open tool call stays open. */
	#closeOpenProse(): void {
		if (this.#open && this.#open.kind !== "function_call") this.#closeOpen();
	}

	#textStart(partial: AssistantMessage, contentIndex: number): void {
		const block = partial.content[contentIndex];
		const signature = block?.type === "text" ? parseTextSignature(block.textSignature) : undefined;
		let cur: OpenMessage;
		if (this.#open?.kind === "message" && sameMessageSignature(this.#open.signature, signature)) {
			// Continue the same message item with a new content part.
			cur = this.#open;
			cur.currentPartText = "";
		} else {
			this.#closeOpenProse();
			cur = this.#openMessage(signature);
		}
		this.#emit("response.content_part.added", {
			item_id: cur.itemId,
			output_index: cur.outputIndex,
			content_index: cur.contentIndex,
			part: { type: "output_text", text: "", annotations: [] },
		});
	}

	#openMessage(signature: MessageSignature | undefined): OpenMessage {
		const outputIndex = this.#outputIndex++;
		const itemId = signature?.id ?? makeMsgId();
		const phase = signature?.phase ? { phase: signature.phase } : {};
		const item = { type: "message", id: itemId, status: "in_progress", role: "assistant", content: [], ...phase };
		this.#emit("response.output_item.added", { output_index: outputIndex, item });
		const next: OpenMessage = {
			kind: "message",
			itemId,
			outputIndex,
			contentIndex: 0,
			currentPartText: "",
			content: [],
			...(signature ? { signature } : {}),
		};
		this.#open = next;
		return next;
	}

	#textDelta(delta: string): void {
		if (this.#open?.kind !== "message") return;
		const cur = this.#open;
		cur.currentPartText += delta;
		this.#emit("response.output_text.delta", {
			item_id: cur.itemId,
			output_index: cur.outputIndex,
			content_index: cur.contentIndex,
			delta,
			logprobs: [],
		});
		// TODO: when pi-ai surfaces output_text annotations
		// (web_search citations, …), emit
		// `response.output_text.annotation.added` here.
	}

	#textEnd(content: string | undefined): void {
		if (this.#open?.kind !== "message") return;
		const cur = this.#open;
		const text = content ?? cur.currentPartText;
		const where = { item_id: cur.itemId, output_index: cur.outputIndex, content_index: cur.contentIndex };
		this.#emit("response.output_text.done", { ...where, text, logprobs: [] });
		cur.content.push({ type: "output_text", text, annotations: [] });
		this.#emit("response.content_part.done", { ...where, part: { type: "output_text", text, annotations: [] } });
		cur.contentIndex += 1;
		cur.currentPartText = "";
	}

	#thinkingStart(partial: AssistantMessage, contentIndex: number): void {
		this.#closeOpenProse();
		const outputIndex = this.#outputIndex++;
		const part = partial.content[contentIndex];
		const itemId = part?.type === "thinking" ? reasoningItemId(part) : makeReasoningId();
		this.#emit("response.output_item.added", {
			output_index: outputIndex,
			item: { type: "reasoning", id: itemId, summary: [] },
		});
		// Open the summary part. Real OpenAI streams summary text in the
		// canonical `reasoning_summary_*` lifecycle; pi-ai's own decoder
		// reads `summary[].text` from the eventual `output_item.done`.
		this.#emit("response.reasoning_summary_part.added", {
			item_id: itemId,
			output_index: outputIndex,
			summary_index: 0,
			part: { type: "summary_text", text: "" },
		});
		this.#open = { kind: "reasoning", itemId, outputIndex, reasoningText: "" };
	}

	#thinkingDelta(delta: string): void {
		if (this.#open?.kind !== "reasoning") return;
		const cur = this.#open;
		cur.reasoningText += delta;
		this.#emit("response.reasoning_summary_text.delta", {
			item_id: cur.itemId,
			output_index: cur.outputIndex,
			summary_index: 0,
			delta,
		});
	}

	#thinkingEnd(content: string | undefined): void {
		if (this.#open?.kind !== "reasoning") return;
		const cur = this.#open;
		const text = content ?? cur.reasoningText;
		cur.reasoningText = text;
		const where = { item_id: cur.itemId, output_index: cur.outputIndex, summary_index: 0 };
		this.#emit("response.reasoning_summary_text.done", { ...where, text });
		this.#emit("response.reasoning_summary_part.done", { ...where, part: { type: "summary_text", text } });
		this.#closeOpen();
	}

	#toolCallStart(partial: AssistantMessage, contentIndex: number): void {
		this.#closeOpenProse();
		const outputIndex = this.#outputIndex++;
		const part = partial.content[contentIndex];
		const tc = part?.type === "toolCall" ? part : undefined;
		const customWireName = tc?.customWireName || undefined;
		const itemId = tc?.thoughtSignature ?? (customWireName !== undefined ? makeCustomCallId() : makeFuncCallId());
		const callId = wireCallId(tc?.id ?? "");
		const name = customWireName ?? tc?.name ?? "";
		const item =
			customWireName !== undefined
				? { type: "custom_tool_call", id: itemId, call_id: callId, name, input: "", status: "in_progress" }
				: { type: "function_call", id: itemId, call_id: callId, name, arguments: "", status: "in_progress" };
		this.#emit("response.output_item.added", { output_index: outputIndex, item });
		const next: OpenFunctionCall = {
			kind: "function_call",
			itemId,
			outputIndex,
			contentIndex,
			callId,
			name,
			argsText: "",
			...(customWireName !== undefined ? { customWireName } : {}),
		};
		this.#openCalls.set(contentIndex, next);
		this.#open = next;
	}

	/** The open call an event at `contentIndex` writes to: the call opened there, else the open item when it is a call. */
	#callFor(contentIndex: number): OpenFunctionCall | undefined {
		const byIndex = this.#openCalls.get(contentIndex);
		if (byIndex) return byIndex;
		return this.#open?.kind === "function_call" ? this.#open : undefined;
	}

	#toolCallDelta(contentIndex: number, delta: string): void {
		const cur = this.#callFor(contentIndex);
		if (!cur) return;
		cur.argsText += delta;
		const name = cur.customWireName
			? "response.custom_tool_call_input.delta"
			: "response.function_call_arguments.delta";
		this.#emit(name, { item_id: cur.itemId, output_index: cur.outputIndex, delta });
	}

	#toolCallEnd(contentIndex: number, tc: ToolCall): void {
		const cur = this.#callFor(contentIndex);
		if (!cur) return;
		// Promote possibly-late info from the canonical ToolCall.
		if (tc.customWireName && !cur.customWireName) cur.customWireName = tc.customWireName;
		if (tc.thoughtSignature) cur.itemId = tc.thoughtSignature;
		cur.callId = wireCallId(tc.id);
		cur.name = cur.customWireName ?? tc.name;
		const where = { item_id: cur.itemId, output_index: cur.outputIndex };
		if (cur.customWireName) {
			// Custom tool: raw input string. Streamed deltas accumulated the wire-level body; fall back to
			// `arguments.input` from the finalized ToolCall when nothing streamed (rare).
			const input = tc.arguments?.input;
			cur.argsText ||= typeof input === "string" ? input : "";
			this.#emit("response.custom_tool_call_input.done", { ...where, input: cur.argsText, name: cur.name });
		} else {
			// Standard JSON tool: arguments object on the veyyon side, the wire wants the JSON string the
			// model emitted (= streamed deltas).
			cur.argsText ||= JSON.stringify(tc.arguments ?? {});
			this.#emit("response.function_call_arguments.done", { ...where, arguments: cur.argsText, name: cur.name });
		}
		this.#closeCall(cur);
	}

	#closeCall(call: OpenFunctionCall): void {
		const item = call.customWireName
			? customToolCallItem(call.itemId, call.callId, call.customWireName, call.argsText)
			: functionCallItem(call.itemId, call.callId, call.name, call.argsText);
		this.#emit("response.output_item.done", { output_index: call.outputIndex, item });
		this.#finished.push(item);
		this.#openCalls.delete(call.contentIndex);
		if (this.#open === call) this.#open = null;
	}

	#closeOpen(): void {
		const open = this.#open;
		if (!open) return;
		if (open.kind === "function_call") return this.#closeCall(open);
		this.#open = null;
		const item: OutputItem =
			open.kind === "message"
				? {
						type: "message",
						id: open.itemId,
						status: "completed",
						role: "assistant",
						content: open.content,
						...(open.signature?.phase ? { phase: open.signature.phase } : {}),
					}
				: { type: "reasoning", id: open.itemId, summary: [{ type: "summary_text", text: open.reasoningText }] };
		this.#emit("response.output_item.done", { output_index: open.outputIndex, item });
		this.#finished.push(item);
	}
}

export function encodeStream(
	events: AssistantMessageEventStream,
	requestedModelId: string,
	_options?: AuthGatewayParsedRequest["options"],
	control?: AuthGatewayStreamControl,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const responseId = makeRespId();
	let cancelled = control?.signal?.aborted === true;
	const markCancelled = () => {
		cancelled = true;
	};
	control?.signal?.addEventListener("abort", markCancelled, { once: true });

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const sink: FrameSink = {
				get cancelled() {
					return cancelled;
				},
				enqueue: frame => controller.enqueue(encoder.encode(frame)),
			};
			const writer = new ResponsesStreamWriter(sink, responseId, requestedModelId);
			try {
				if (cancelled) {
					controller.close();
					return;
				}
				for await (const ev of events) {
					if (cancelled) return;
					writer.apply(ev);
				}
				await writer.finish(events);
				controller.close();
			} catch (err) {
				if (!cancelled) {
					writer.fail(err);
					controller.close();
				}
			} finally {
				control?.signal?.removeEventListener("abort", markCancelled);
			}
		},
		cancel(reason) {
			cancelled = true;
			control?.signal?.removeEventListener("abort", markCancelled);
			control?.onCancel?.(reason);
		},
	});
}
