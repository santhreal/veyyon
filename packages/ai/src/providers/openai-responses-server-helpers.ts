import { errorMessage } from "@veyyon/utils/type-guards";
import type { AuthGatewayStreamControl, AuthGatewayParsedRequest as ParsedRequest } from "../auth-gateway/types";
import type { AssistantMessage, AssistantMessageEventStream } from "../types";
import { parseTextSignature } from "./openai-shared";

export type { ParsedRequest };

import {
	buildOutputItems,
	buildUsage,
	incompleteDetailsForStatus,
	type MessageSignature,
	makeCustomCallId,
	makeFuncCallId,
	makeMsgId,
	makeReasoningId,
	makeRespId,
	type OutputItem,
	type ResponseStatus,
	reasoningItemId,
	responseStatusForStopReason,
	wireCallId,
} from "./openai-responses-server";

function buildResponseEnvelope(
	message: AssistantMessage,
	requestedModelId: string,
	id: string,
	status: ResponseStatus,
	items: OutputItem[] | [],
	usage: Record<string, unknown> | null,
): Record<string, unknown> {
	return {
		id,
		object: "response",
		created_at: Math.floor(message.timestamp / 1000),
		status,
		model: requestedModelId,
		output: items,
		usage,
		incomplete_details: incompleteDetailsForStatus(status),
		...(status === "failed" ? { error: { message: message.errorMessage ?? "response failed" } } : {}),
	};
}

export function encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown> {
	const items = buildOutputItems(message);
	return buildResponseEnvelope(
		message,
		requestedModelId,
		makeRespId(),
		responseStatusForStopReason(message),
		items,
		buildUsage(message),
	);
}

export interface OpenMessage {
	kind: "message";
	itemId: string;
	outputIndex: number;
	contentIndex: number;
	currentPartText: string;
	content: Array<{ type: "output_text"; text: string; annotations: never[] }>;
	signature?: MessageSignature;
}
export interface OpenReasoning {
	kind: "reasoning";
	itemId: string;
	outputIndex: number;
	reasoningText: string;
}
export interface OpenFunctionCall {
	kind: "function_call";
	itemId: string;
	outputIndex: number;
	contentIndex: number;
	callId: string;
	name: string;
	argsText: string;
	customWireName?: string;
}
export type OpenItem = OpenMessage | OpenReasoning | OpenFunctionCall;

export function sseEvent(name: string, data: unknown): string {
	return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function encodeStream(
	events: AssistantMessageEventStream,
	requestedModelId: string,
	_options?: ParsedRequest["options"],
	control?: AuthGatewayStreamControl,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const responseId = makeRespId();
	let sequenceNumber = 0;
	let cancelled = control?.signal?.aborted === true;
	const markCancelled = () => {
		cancelled = true;
	};
	control?.signal?.addEventListener("abort", markCancelled, { once: true });
	const seq = () => sequenceNumber++;

	return new ReadableStream<Uint8Array>({
		async start(controller) {
			const emit = (name: string, data: Record<string, unknown>) => {
				if (!cancelled)
					controller.enqueue(encoder.encode(sseEvent(name, { type: name, sequence_number: seq(), ...data })));
			};
			const emitDone = () => {
				if (!cancelled) controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			};

			let createdAt = Math.floor(Date.now() / 1000);
			let outputIndex = 0;
			const state: { open: OpenItem | null } = { open: null };
			const openFunctionCalls = new Map<number, OpenFunctionCall>();
			const finishedItems: OutputItem[] = [];
			const allocateOutputIndex = (): number => outputIndex++;

			const responseSnapshot = (status: ResponseStatus, output: OutputItem[] | []) => ({
				id: responseId,
				object: "response",
				created_at: createdAt,
				status,
				model: requestedModelId,
				output,
				usage: null,
				incomplete_details: incompleteDetailsForStatus(status),
			});

			const openMessage = (signature?: MessageSignature): OpenMessage => {
				const itemOutputIndex = allocateOutputIndex();
				const itemId = signature?.id ?? makeMsgId();
				const item = {
					type: "message" as const,
					id: itemId,
					status: "in_progress" as const,
					role: "assistant" as const,
					content: [] as Array<{ type: "output_text"; text: string; annotations: never[] }>,
					...(signature?.phase ? { phase: signature.phase } : {}),
				};
				emit("response.output_item.added", { output_index: itemOutputIndex, item });
				const next: OpenMessage = {
					kind: "message",
					itemId,
					outputIndex: itemOutputIndex,
					contentIndex: 0,
					currentPartText: "",
					content: [],
					...(signature ? { signature } : {}),
				};
				state.open = next;
				return next;
			};

			const openReasoning = (partial: AssistantMessage, contentIndex: number): OpenReasoning => {
				const itemOutputIndex = allocateOutputIndex();
				const part = partial.content[contentIndex];
				const itemId = part && part.type === "thinking" ? reasoningItemId(part) : makeReasoningId();
				const item = {
					type: "reasoning" as const,
					id: itemId,
					summary: [] as Array<{ type: "summary_text"; text: string }>,
				};
				emit("response.output_item.added", { output_index: itemOutputIndex, item });
				emit("response.reasoning_summary_part.added", {
					item_id: itemId,
					output_index: itemOutputIndex,
					summary_index: 0,
					part: { type: "summary_text", text: "" },
				});
				const next: OpenReasoning = { kind: "reasoning", itemId, outputIndex: itemOutputIndex, reasoningText: "" };
				state.open = next;
				return next;
			};

			const openToolCall = (partial: AssistantMessage, contentIndex: number): OpenFunctionCall => {
				const itemOutputIndex = allocateOutputIndex();
				const part = partial.content[contentIndex];
				const tc = part && part.type === "toolCall" ? part : undefined;
				const customWireName: string | undefined =
					tc && typeof tc.customWireName === "string" && tc.customWireName.length > 0
						? tc.customWireName
						: undefined;
				const isCustom = customWireName !== undefined;
				const itemId = tc?.thoughtSignature ?? (isCustom ? makeCustomCallId() : makeFuncCallId());
				const callId = wireCallId(tc?.id ?? "");
				const name = customWireName ?? tc?.name ?? "";
				const item = isCustom
					? {
							type: "custom_tool_call" as const,
							id: itemId,
							call_id: callId,
							name,
							input: "",
							status: "in_progress",
						}
					: {
							type: "function_call" as const,
							id: itemId,
							call_id: callId,
							name,
							arguments: "",
							status: "in_progress",
						};
				emit("response.output_item.added", { output_index: itemOutputIndex, item });
				const next: OpenFunctionCall = {
					kind: "function_call",
					itemId,
					outputIndex: itemOutputIndex,
					contentIndex,
					callId,
					name,
					argsText: "",
					...(isCustom ? { customWireName } : {}),
				};
				openFunctionCalls.set(contentIndex, next);
				state.open = next;
				return next;
			};

			const closeFunctionCall = (call: OpenFunctionCall): void => {
				const text = call.argsText ?? "";
				if (call.customWireName) {
					const item = {
						type: "custom_tool_call",
						id: call.itemId,
						call_id: call.callId ?? "",
						name: call.customWireName,
						input: text,
						status: "completed",
					};
					emit("response.output_item.done", { output_index: call.outputIndex, item });
					finishedItems.push({
						type: "custom_tool_call",
						id: call.itemId,
						call_id: call.callId ?? "",
						name: call.customWireName,
						input: text,
						status: "completed",
					});
				} else {
					const item = {
						type: "function_call",
						id: call.itemId,
						call_id: call.callId ?? "",
						name: call.name ?? "",
						arguments: text,
						status: "completed",
					};
					emit("response.output_item.done", { output_index: call.outputIndex, item });
					finishedItems.push({
						type: "function_call",
						id: call.itemId,
						call_id: call.callId ?? "",
						name: call.name ?? "",
						arguments: text,
						status: "completed",
					});
				}
				openFunctionCalls.delete(call.contentIndex);
				if (state.open === call) state.open = null;
			};

			const closeOpen = () => {
				if (!state.open) return;
				if (state.open.kind === "message") {
					const item = {
						type: "message" as const,
						id: state.open.itemId,
						status: "completed" as const,
						role: "assistant" as const,
						content: state.open.content,
						...(state.open.signature?.phase ? { phase: state.open.signature.phase } : {}),
					};
					emit("response.output_item.done", { output_index: state.open.outputIndex, item });
					finishedItems.push(item);
					state.open = null;
				} else if (state.open.kind === "reasoning") {
					const summary = [{ type: "summary_text" as const, text: state.open.reasoningText ?? "" }];
					const item = {
						type: "reasoning",
						id: state.open.itemId,
						summary,
					};
					emit("response.output_item.done", { output_index: state.open.outputIndex, item });
					finishedItems.push({
						type: "reasoning",
						id: state.open.itemId,
						summary,
					});
					state.open = null;
				} else {
					closeFunctionCall(state.open);
				}
			};

			const closeOpenFunctionCalls = (): void => {
				for (const call of Array.from(openFunctionCalls.values())) {
					closeFunctionCall(call);
				}
			};

			const functionCallForEvent = (contentIndex: number): OpenFunctionCall | undefined => {
				const byIndex = openFunctionCalls.get(contentIndex);
				if (byIndex) return byIndex;
				return state.open?.kind === "function_call" ? state.open : undefined;
			};
			let finalMessage: AssistantMessage | undefined;
			let failureMessage: AssistantMessage | undefined;
			try {
				if (cancelled) {
					controller.close();
					return;
				}
				for await (const ev of events) {
					if (cancelled) return;
					switch (ev.type) {
						case "start": {
							createdAt = Math.floor((ev.partial.timestamp || Date.now()) / 1000);
							emit("response.created", { response: responseSnapshot("in_progress", []) });
							emit("response.in_progress", { response: responseSnapshot("in_progress", []) });
							break;
						}
						case "text_start": {
							let cur: OpenMessage;
							const textBlock = ev.partial.content[ev.contentIndex];
							const signature =
								textBlock?.type === "text" ? parseTextSignature(textBlock.textSignature) : undefined;
							if (state.open && state.open.kind === "message") {
								const sameSignature =
									(!signature && !state.open.signature) ||
									(signature !== undefined &&
										state.open.signature?.id === signature.id &&
										state.open.signature.phase === signature.phase);
								if (sameSignature) {
									cur = state.open;
									cur.currentPartText = "";
								} else {
									closeOpen();
									cur = openMessage(signature);
								}
							} else {
								if (state.open && state.open.kind !== "function_call") closeOpen();
								cur = openMessage(signature);
							}
							const contentPart = { type: "output_text", text: "", annotations: [] as never[] };
							emit("response.content_part.added", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: cur.contentIndex,
								part: contentPart,
							});
							break;
						}
						case "text_delta": {
							if (state.open?.kind !== "message") break;
							const cur: OpenMessage = state.open;
							cur.currentPartText += ev.delta;
							emit("response.output_text.delta", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: cur.contentIndex,
								delta: ev.delta,
								logprobs: [],
							});
							break;
						}
						case "text_end": {
							if (state.open?.kind !== "message") break;
							const cur: OpenMessage = state.open;
							const text = ev.content ?? cur.currentPartText;
							emit("response.output_text.done", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: cur.contentIndex,
								text,
								logprobs: [],
							});
							cur.content.push({ type: "output_text", text, annotations: [] });
							emit("response.content_part.done", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								content_index: cur.contentIndex,
								part: { type: "output_text", text, annotations: [] },
							});
							cur.contentIndex += 1;
							cur.currentPartText = "";
							break;
						}
						case "thinking_start": {
							if (state.open && state.open.kind !== "function_call") closeOpen();
							openReasoning(ev.partial, ev.contentIndex);
							break;
						}
						case "thinking_delta": {
							if (state.open?.kind !== "reasoning") break;
							const cur: OpenReasoning = state.open;
							cur.reasoningText += ev.delta;
							emit("response.reasoning_summary_text.delta", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								summary_index: 0,
								delta: ev.delta,
							});
							break;
						}
						case "thinking_end": {
							if (state.open?.kind !== "reasoning") break;
							const cur: OpenReasoning = state.open;
							const text = ev.content ?? cur.reasoningText;
							cur.reasoningText = text;
							emit("response.reasoning_summary_text.done", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								summary_index: 0,
								text,
							});
							emit("response.reasoning_summary_part.done", {
								item_id: cur.itemId,
								output_index: cur.outputIndex,
								summary_index: 0,
								part: { type: "summary_text", text },
							});
							closeOpen();
							break;
						}
						case "toolcall_start": {
							if (state.open && state.open.kind !== "function_call") closeOpen();
							openToolCall(ev.partial, ev.contentIndex);
							break;
						}
						case "toolcall_delta": {
							const cur = functionCallForEvent(ev.contentIndex);
							if (!cur) break;
							cur.argsText += ev.delta;
							if (cur.customWireName) {
								emit("response.custom_tool_call_input.delta", {
									item_id: cur.itemId,
									output_index: cur.outputIndex,
									delta: ev.delta,
								});
							} else {
								emit("response.function_call_arguments.delta", {
									item_id: cur.itemId,
									output_index: cur.outputIndex,
									delta: ev.delta,
								});
							}
							break;
						}
						case "toolcall_end": {
							const cur = functionCallForEvent(ev.contentIndex);
							if (!cur) break;
							const tc = ev.toolCall;
							if (tc.customWireName && !cur.customWireName) cur.customWireName = tc.customWireName;
							if (tc.thoughtSignature) cur.itemId = tc.thoughtSignature;
							cur.callId = tc.id;
							cur.name = cur.customWireName ?? tc.name;
							if (cur.customWireName) {
								const rawInput =
									cur.argsText ||
									(typeof tc.arguments?.input === "string" ? (tc.arguments.input as string) : "");
								cur.argsText = rawInput;
								emit("response.custom_tool_call_input.done", {
									item_id: cur.itemId,
									output_index: cur.outputIndex,
									input: rawInput,
									name: cur.name,
								});
							} else {
								const argsJson = cur.argsText || JSON.stringify(tc.arguments ?? {});
								cur.argsText = argsJson;
								emit("response.function_call_arguments.done", {
									item_id: cur.itemId,
									output_index: cur.outputIndex,
									arguments: argsJson,
									name: cur.name,
								});
							}
							closeFunctionCall(cur);
							break;
						}
						case "done": {
							finalMessage = ev.message;
							break;
						}
						case "error": {
							failureMessage = ev.error;
							break;
						}
					}
				}

				if (failureMessage) {
					closeOpenFunctionCalls();
					if (state.open) closeOpen();
					controller.enqueue(
						encoder.encode(
							sseEvent("response.failed", {
								type: "response.failed",
								sequence_number: seq(),
								response: {
									...responseSnapshot("failed", finishedItems),
									error: { message: failureMessage.errorMessage ?? "stream failed" },
								},
							}),
						),
					);
					emitDone();
					controller.close();
					return;
				}

				closeOpenFunctionCalls();
				if (state.open) closeOpen();
				let resultFailure: string | undefined;
				const message =
					finalMessage ??
					((await events.result().catch((error: unknown) => {
						resultFailure = errorMessage(error);
						return null;
					})) as AssistantMessage | null);
				if (!message) {
					closeOpenFunctionCalls();
					controller.enqueue(
						encoder.encode(
							sseEvent("response.failed", {
								type: "response.failed",
								sequence_number: seq(),
								response: {
									...responseSnapshot("failed", finishedItems),
									error: {
										message: resultFailure ?? "stream ended without a final message",
									},
								},
							}),
						),
					);
					emitDone();
					controller.close();
					return;
				}

				const items = buildOutputItems(message);
				const usage = buildUsage(message);
				const status = responseStatusForStopReason(message);
				const terminalEvent =
					status === "incomplete"
						? "response.incomplete"
						: status === "failed"
							? "response.failed"
							: "response.completed";
				controller.enqueue(
					encoder.encode(
						sseEvent(terminalEvent, {
							type: terminalEvent,
							sequence_number: seq(),
							response: {
								id: responseId,
								object: "response",
								created_at: createdAt,
								status,
								model: requestedModelId,
								output: items,
								usage,
								incomplete_details: incompleteDetailsForStatus(status),
								...(status === "failed"
									? { error: { message: message.errorMessage ?? "response failed" } }
									: {}),
							},
						}),
					),
				);
				emitDone();
				controller.close();
			} catch (err) {
				if (!cancelled) {
					controller.enqueue(
						encoder.encode(
							sseEvent("response.failed", {
								type: "response.failed",
								sequence_number: seq(),
								response: {
									id: responseId,
									object: "response",
									created_at: Math.floor(Date.now() / 1000),
									status: "failed",
									model: requestedModelId,
									output: [],
									error: { message: errorMessage(err) },
									incomplete_details: null,
								},
							}),
						),
					);
					emitDone();
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
