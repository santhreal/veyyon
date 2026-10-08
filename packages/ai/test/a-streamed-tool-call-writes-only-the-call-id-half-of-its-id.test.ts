/**
 * Every `call_id` the auth-gateway's OpenAI Responses encoders write is the call-id half of the tool
 * call's id.
 *
 * WHY THIS SUITE EXISTS. Responses providers mint composite `"{call_id}|{item_id}"` tool-call ids. Only
 * the first half belongs on the wire: clients validate `call_id` against `^[a-zA-Z0-9_-]+$` or echo it to
 * another backend, and `|` fails both. `response.output_item.added` and the terminal response wrote the
 * half, but `toolcall_end` replaced the open call's id with the raw composite, so the
 * `response.output_item.done` frame a client records the call from carried `call_1|fc_1`.
 *
 * The class it closes: a composite id reaching any `call_id` in any frame or in the non-streamed
 * response, for function and custom tools, a custom tool recognised only at `toolcall_end`, calls with and
 * without an item id or streamed arguments. The suite walks every object of every frame, so a frame that
 * starts carrying `call_id` is covered without being named here.
 *
 * WHAT IT DOES NOT CATCH. The `call_id` of an inbound request item, which the gateway reads rather than
 * writes.
 */

import { describe, expect, it } from "bun:test";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@veyyon/ai";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { encodeResponse } from "../src/providers/openai-responses-server-output";
import { encodeStream } from "../src/providers/openai-responses-server-stream";

const IDS: ReadonlyArray<[id: string, wire: string]> = [
	["call_1|fc_1", "call_1"],
	["call_2", "call_2"],
	["call_3|", "call_3"],
	["call_4|fc_4|extra", "call_4"],
];

type Kind = "function" | "custom" | "custom recognised at end";
const KINDS: readonly Kind[] = ["function", "custom", "custom recognised at end"];

interface Case {
	label: string;
	wire: string;
	call: ToolCall;
	kind: Kind;
	streamed: boolean;
}

function cases(): Case[] {
	const out: Case[] = [];
	for (const [id, wire] of IDS) {
		for (const kind of KINDS) {
			for (const thoughtSignature of [undefined, "fc_item"]) {
				for (const streamed of [true, false]) {
					const call: ToolCall =
						kind === "function"
							? { type: "toolCall", id, name: "read", arguments: { path: "a" } }
							: {
									type: "toolCall",
									id,
									name: "apply_patch",
									arguments: { input: "*** x" },
									customWireName: "apply_patch",
								};
					if (thoughtSignature) call.thoughtSignature = thoughtSignature;
					const label = `${kind} ${id} ${thoughtSignature ? "with" : "without"} item id, ${streamed ? "streamed" : "unstreamed"} arguments`;
					out.push({ label, wire, call, kind, streamed });
				}
			}
		}
	}
	return out;
}

function message(call: ToolCall): AssistantMessage {
	return {
		role: "assistant",
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		content: [call],
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1_700_000_000_000,
	};
}

function eventsFor(test: Case): AssistantMessageEvent[] {
	const final = message(test.call);
	// A custom tool recognised only at the end streams as a function call until `toolcall_end` names it.
	const { customWireName: _late, ...asFunction } = test.call;
	const partial = test.kind === "custom recognised at end" ? message(asFunction) : final;
	const at = { contentIndex: 0, partial };
	const events: AssistantMessageEvent[] = [
		{ type: "start", partial },
		{ type: "toolcall_start", ...at },
	];
	if (test.streamed) {
		const delta = test.kind === "function" ? JSON.stringify(test.call.arguments) : String(test.call.arguments.input);
		events.push({ type: "toolcall_delta", ...at, delta });
	}
	events.push({ type: "toolcall_end", ...at, toolCall: test.call });
	events.push({ type: "done", reason: "toolUse", message: final });
	return events;
}

/** Every `call_id` value anywhere in `value`, with the path it was found at. */
function callIds(value: unknown, path: string, out: Array<{ path: string; callId: unknown }>): void {
	if (Array.isArray(value)) {
		for (const [index, entry] of value.entries()) callIds(entry, `${path}[${index}]`, out);
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [key, entry] of Object.entries(value)) {
		if (key === "call_id") out.push({ path: `${path}.call_id`, callId: entry });
		callIds(entry, `${path}.${key}`, out);
	}
}

async function streamedCallIds(test: Case): Promise<Array<{ path: string; callId: unknown }>> {
	const source = new AssistantMessageEventStream();
	for (const event of eventsFor(test)) source.push(event);
	const body = await new Response(encodeStream(source, "gpt-5-requested")).text();
	const out: Array<{ path: string; callId: unknown }> = [];
	for (const frame of body.split("\n\n")) {
		const event = frame.match(/^event: (\S+)$/m)?.[1];
		const data = frame.match(/^data: (.*)$/m)?.[1];
		if (event && data && data !== "[DONE]") callIds(JSON.parse(data), event, out);
	}
	return out;
}

describe("a streamed tool call writes only the call-id half of its id", () => {
	it("on every frame that carries a call_id", async () => {
		const wrong: unknown[] = [];
		for (const test of cases()) {
			const found = await streamedCallIds(test);
			const paths = found.map(entry => entry.path);
			// The call is announced, finished and reported in the terminal response.
			expect(paths, test.label).toEqual([
				"response.output_item.added.item.call_id",
				"response.output_item.done.item.call_id",
				"response.completed.response.output[0].call_id",
			]);
			for (const entry of found) {
				if (entry.callId !== test.wire) wrong.push({ case: test.label, ...entry });
			}
		}
		expect(wrong).toEqual([]);
	});

	it("in a response written whole", () => {
		const wrong = cases().flatMap(test => {
			const found: Array<{ path: string; callId: unknown }> = [];
			callIds(encodeResponse(message(test.call), "gpt-5-requested"), "response", found);
			expect(found.length, test.label).toBe(1);
			return found.filter(entry => entry.callId !== test.wire).map(entry => ({ case: test.label, ...entry }));
		});
		expect(wrong).toEqual([]);
	});
});
