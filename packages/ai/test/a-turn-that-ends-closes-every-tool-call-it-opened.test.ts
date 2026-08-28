/**
 * WHY. Cursor opens every call of a batch before it closes any of them, and a
 * turn can reach `turn_ended` with several still open — an interrupt, a server
 * that stops sending completions, a batch whose last completion never arrives.
 * The provider closed "the current tool call" at that point, one block, chosen
 * by a pointer that names whichever call opened last. Every earlier call of the
 * batch got no `toolcall_end`, so its argument buffer stayed set, and a set
 * buffer is exactly the marker the agent loop reads as "this call's arguments
 * never finished streaming". A complete call was deleted from the turn and
 * reported to the model as unreconstructable.
 *
 * The defect class: end-of-stream cleanup that closes one thing when the state
 * machine can have many open. A suite driving one call per turn cannot see any
 * member of it, because with one call the pointer is always right.
 *
 * This drives the real `streamCursor` against a localhost h2 server replaying a
 * frame script, so the assertions are about what the provider emits over a
 * socket, not about a state machine called by hand.
 *
 * What this suite does NOT catch: it ends the script cleanly after
 * `turn_ended`, so a connection that drops mid-frame takes a different path
 * (the incomplete-stream error), and that path is owned by the turn-ended
 * suite next door.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as http2 from "node:http2";
import { create, toBinary } from "@bufbuild/protobuf";
import { streamCursor } from "@veyyon/ai/providers/cursor";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, ToolCall } from "@veyyon/ai/types";
import { getStreamingPartialJson } from "@veyyon/ai/utils/block-symbols";
import { buildModel } from "@veyyon/catalog/build";
import {
	AgentServerMessageSchema,
	InteractionUpdateSchema,
	McpArgsSchema,
	McpToolCallSchema,
	PartialToolCallUpdateSchema,
	ToolCallSchema,
	ToolCallStartedUpdateSchema,
	TurnEndedUpdateSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";

/** Cursor's own id shape: the interaction call id and the function-call id, joined. */
function callId(index: number): string {
	return `call-1c6e0b52-3d47-4a19-9f80-2b7c5a4e6d13-${index}\nfc_74a2c9e1-5b83-4d0f-8c62-1e9a3f5b7d04_${index}`;
}

function frame(payload: Uint8Array): Buffer {
	const header = Buffer.alloc(5);
	header.writeUInt8(0, 0);
	header.writeUInt32BE(payload.length, 1);
	return Buffer.concat([header, Buffer.from(payload)]);
}

function encodeArgs(args: Record<string, unknown>): Record<string, Uint8Array> {
	const encoder = new TextEncoder();
	const encoded: Record<string, Uint8Array> = {};
	for (const [key, value] of Object.entries(args)) {
		encoded[key] = encoder.encode(typeof value === "string" ? value : JSON.stringify(value));
	}
	return encoded;
}

/** `tool_call_started` for an MCP call, the shape a veyyon tool arrives as. */
function startedFrame(id: string, name: string, args: Record<string, unknown>): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "toolCallStarted",
					value: create(ToolCallStartedUpdateSchema, {
						callId: id,
						toolCall: create(ToolCallSchema, {
							tool: {
								case: "mcpToolCall",
								value: create(McpToolCallSchema, {
									args: create(McpArgsSchema, {
										toolCallId: id,
										name,
										toolName: name,
										args: encodeArgs(args),
									}),
								}),
							},
						}),
					}),
				},
			}),
		},
	});
	return frame(toBinary(AgentServerMessageSchema, message));
}

/** `partial_tool_call`: a cumulative snapshot of the args JSON text. */
function partialFrame(id: string, snapshot: string): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: {
					case: "partialToolCall",
					value: create(PartialToolCallUpdateSchema, { callId: id, argsTextDelta: snapshot }),
				},
			}),
		},
	});
	return frame(toBinary(AgentServerMessageSchema, message));
}

function turnEndedFrame(): Buffer {
	const message = create(AgentServerMessageSchema, {
		message: {
			case: "interactionUpdate",
			value: create(InteractionUpdateSchema, {
				message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) },
			}),
		},
	});
	return frame(toBinary(AgentServerMessageSchema, message));
}

interface FakeCursorServer {
	baseUrl: string;
	close: () => Promise<void>;
}

/** A localhost h2c server that replays a fixed frame script and then ends. */
function startH2Server(script: Buffer[]): Promise<FakeCursorServer> {
	const server = http2.createServer();
	server.on("stream", (stream: http2.ServerHttp2Stream) => {
		stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
		for (const chunk of script) stream.write(chunk);
		stream.end();
	});
	const { promise, resolve } = Promise.withResolvers<FakeCursorServer>();
	server.listen(0, "127.0.0.1", () => {
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const closed = () => {
			const done = Promise.withResolvers<void>();
			server.close(() => done.resolve());
			return done.promise;
		};
		resolve({ baseUrl: `http://127.0.0.1:${port}`, close: closed });
	});
	return promise;
}

const cursorModel = (baseUrl: string): Model<"cursor-agent"> =>
	buildModel({
		id: "cursor-composer-2.5",
		name: "Cursor Composer 2.5",
		api: "cursor-agent",
		provider: "cursor",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	});

const context: Context = { messages: [{ role: "user", content: "run both", timestamp: 1 }] };

interface TurnResult {
	events: AssistantMessageEvent[];
	message: AssistantMessage;
}

async function runTurn(baseUrl: string): Promise<TurnResult> {
	const events: AssistantMessageEvent[] = [];
	let message: AssistantMessage | undefined;
	for await (const event of streamCursor(cursorModel(baseUrl), context, { apiKey: "test-token" })) {
		events.push(event);
		if (event.type === "done") message = event.message;
		if (event.type === "error") message = event.error;
	}
	if (!message) throw new Error("stream produced no terminal event");
	return { events, message };
}

function endEvents(events: AssistantMessageEvent[]): Array<{ id: string; arguments: unknown }> {
	return events
		.filter(
			(event): event is Extract<AssistantMessageEvent, { type: "toolcall_end" }> => event.type === "toolcall_end",
		)
		.map(event => ({ id: event.toolCall.id, arguments: event.toolCall.arguments }));
}

function calls(message: AssistantMessage): ToolCall[] {
	return message.content.filter((block): block is ToolCall => block.type === "toolCall");
}

const FIRST_ARGS = { command: "bun run check:ts" } as const;
const SECOND_ARGS = { command: "bun test", timeout: 900 } as const;

let srv: FakeCursorServer | undefined;

beforeEach(() => {
	srv = undefined;
});

afterEach(async () => {
	await srv?.close();
});

describe("a turn that ends with tool calls still open", () => {
	it("emits one end event per open call, in the order they opened", async () => {
		srv = await startH2Server([
			startedFrame(callId(0), "bash", FIRST_ARGS),
			startedFrame(callId(1), "bash", SECOND_ARGS),
			turnEndedFrame(),
		]);

		const { events } = await runTurn(srv.baseUrl);

		expect(endEvents(events).map(end => end.id)).toEqual([callId(0), callId(1)]);
	});

	it("closes each open call with its own arguments", async () => {
		// The pointer defect showed up here first: one call closed carrying the
		// other's arguments, or carrying nothing.
		srv = await startH2Server([
			startedFrame(callId(0), "bash", FIRST_ARGS),
			startedFrame(callId(1), "bash", SECOND_ARGS),
			turnEndedFrame(),
		]);

		const { events } = await runTurn(srv.baseUrl);

		expect(endEvents(events)).toEqual([
			{ id: callId(0), arguments: FIRST_ARGS },
			{ id: callId(1), arguments: SECOND_ARGS },
		]);
	});

	it("leaves every call in the finished message with its own arguments", async () => {
		srv = await startH2Server([
			startedFrame(callId(0), "bash", FIRST_ARGS),
			startedFrame(callId(1), "bash", SECOND_ARGS),
			turnEndedFrame(),
		]);

		const { message } = await runTurn(srv.baseUrl);

		expect(calls(message).map(call => ({ id: call.id, arguments: call.arguments }))).toEqual([
			{ id: callId(0), arguments: FIRST_ARGS },
			{ id: callId(1), arguments: SECOND_ARGS },
		]);
	});

	it("parses the streamed argument text of a call whose deltas never got a completion", async () => {
		// A call whose arguments arrived as text rather than on the start frame:
		// the end-of-stream close is the only thing that will ever parse it.
		srv = await startH2Server([
			startedFrame(callId(0), "bash", {}),
			partialFrame(callId(0), '{"command":"bun run check:rs"}'),
			turnEndedFrame(),
		]);

		const { events, message } = await runTurn(srv.baseUrl);

		expect(endEvents(events)).toEqual([{ id: callId(0), arguments: { command: "bun run check:rs" } }]);
		expect(calls(message)[0]?.arguments).toEqual({ command: "bun run check:rs" });
	});

	it("parses the tail the mid-stream throttle skipped", async () => {
		// Mid-stream parses are throttled to keep argument decoding linear, so the
		// last snapshot before the turn ends is usually NOT parsed: the buffer has
		// grown by less than the throttle's minimum. Only the end-of-stream parse
		// sees the finished object, and without it the call runs with the tolerant
		// partial parse of an earlier prefix — here, missing a whole argument.
		const filler = "x".repeat(300);
		const prefix = `{"command":"${filler}"`;
		srv = await startH2Server([
			startedFrame(callId(0), "bash", {}),
			partialFrame(callId(0), prefix),
			partialFrame(callId(0), `${prefix},"timeout":900}`),
			turnEndedFrame(),
		]);

		const { message } = await runTurn(srv.baseUrl);

		expect(calls(message)[0]?.arguments).toEqual({ command: filler, timeout: 900 });
	});

	it("leaves no call still marked as streaming its arguments", async () => {
		// The argument buffer IS the open/closed answer: the agent loop reads a
		// surviving marker as "this call's arguments never finished", deletes the
		// call, and tells the model no record of it is left. A call this sweep
		// closed must not look open to that rule.
		srv = await startH2Server([
			startedFrame(callId(0), "bash", FIRST_ARGS),
			startedFrame(callId(1), "bash", SECOND_ARGS),
			turnEndedFrame(),
		]);

		const { message } = await runTurn(srv.baseUrl);

		expect(calls(message).map(call => getStreamingPartialJson(call))).toEqual([undefined, undefined]);
	});

	it("closes three open calls, not just the last one", async () => {
		// Two calls can be closed by accident if the pointer happens to be right
		// for one of them; three makes the pointer wrong for two.
		srv = await startH2Server([
			startedFrame(callId(0), "bash", { command: "a" }),
			startedFrame(callId(1), "bash", { command: "b" }),
			startedFrame(callId(2), "bash", { command: "c" }),
			turnEndedFrame(),
		]);

		const { events } = await runTurn(srv.baseUrl);

		expect(endEvents(events)).toEqual([
			{ id: callId(0), arguments: { command: "a" } },
			{ id: callId(1), arguments: { command: "b" } },
			{ id: callId(2), arguments: { command: "c" } },
		]);
	});

	it("emits exactly one end event for a call the server did close", async () => {
		// The over-close control: a call closed by its own completion must not be
		// closed again by the end-of-stream sweep, which would give the loop two
		// end events for one call.
		srv = await startH2Server([
			startedFrame(callId(0), "bash", FIRST_ARGS),
			startedFrame(callId(1), "bash", SECOND_ARGS),
			turnEndedFrame(),
		]);

		const { events } = await runTurn(srv.baseUrl);
		const ids = endEvents(events).map(end => end.id);

		expect(ids.length).toBe(new Set(ids).size);
	});
	it("reports the turn as finished, with a stop reason the loop still runs tools for", async () => {
		// Cursor's turn carries no finish reason of its own, so the provider reports
		// `stop` even for a turn that asked for a tool. The agent loop treats `stop`
		// and `toolUse` alike when the message carries tool calls, so the calls run;
		// a consumer that branches on `toolUse` alone would not see them.
		srv = await startH2Server([startedFrame(callId(0), "bash", FIRST_ARGS), turnEndedFrame()]);

		const { message, events } = await runTurn(srv.baseUrl);

		expect(message.stopReason).toBe("stop");
		expect(calls(message)).toHaveLength(1);
		expect(events.at(-1)?.type).toBe("done");
	});
});
