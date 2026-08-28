/**
 * WHY. Cursor opens every call of a batch before it streams any of their
 * arguments, and completes them afterwards in issue order:
 *
 *   started(A) → started(B) → args for A → completed(A) → completed(B)
 *
 * The streaming state machine tracked one "current tool call" pointer, so by
 * the time A's arguments and completion arrived the pointer named B. A's
 * arguments were written onto B, A kept the empty object it opened with, and
 * B's own completion found no pointer at all and was dropped. A recorded
 * two-call turn persisted `set_cwd({})` beside `eval({path, i})` — B's name
 * carrying A's arguments — and the argument-less block then reached the tool
 * validator as a SECOND execution under an id that already had a result.
 *
 * The defect class: a per-call fact (arguments, completion, argument buffer,
 * end event) resolved through a single mutable pointer instead of the call id
 * the update carries. Every member of that class corrupts a sibling call
 * rather than the call it names, so a suite that drives one call per turn
 * cannot see any of them. Every case here drives at least two, and the
 * pointer-shaped mutations are the ones it must go red on.
 *
 * The wire order and field names replayed here are the ones a live
 * `cursor-grok-4.6-medium` turn produced: `call_id` on every tool-call update,
 * the whole argument map already present on `toolCallStarted`, and
 * `partialToolCall` frames that arrive before the block they name exists.
 *
 * What this suite does NOT catch: it drives `processInteractionUpdate` and
 * `handleServerMessage` directly, so a change to how updates REACH them — a
 * new update case, a decoder that renames `call_id`, a second state machine —
 * is outside what these assertions can see. It also asserts the argument
 * buffer that `agent-loop.ts` reads rather than running the loop, so a change
 * to how the loop interprets that marker is not covered here either.
 */
import { describe, expect, it } from "bun:test";
import { create } from "@bufbuild/protobuf";
import {
	type BlockState,
	createCursorUsageAccount,
	handleServerMessage,
	type InteractionUpdateView,
	processInteractionUpdate,
	type ToolCallState,
} from "@veyyon/ai/providers/cursor";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	CursorExecHandlers,
	Model,
	ToolCall,
	ToolResultMessage,
} from "@veyyon/ai/types";
import {
	type CursorExecResolvedCarrier,
	getStreamingPartialJson,
	kCursorExecResolved,
} from "@veyyon/ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import {
	AgentServerMessageSchema,
	ExecServerMessageSchema,
	McpArgsSchema,
} from "@veyyon/catalog/discovery/cursor-gen/agent_pb";

/** Cursor's own id shape: the interaction call id and the model's function-call id, joined. */
function callId(index: number): string {
	return `call-3059677f-b703-4b8a-8737-4493b21f4a19-${index}\nfc_eabb0594-4ec2-9515-848e-30f9e1054dcd_${index}`;
}

function cursorAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "cursor-agent",
		provider: "cursor",
		model: "cursor-grok-4.6-medium",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

function newBlockState(output: AssistantMessage): BlockState {
	let textBlock: BlockState["currentTextBlock"] = null;
	let thinkingBlock: BlockState["currentThinkingBlock"] = null;
	let toolCall: ToolCallState | null = null;
	return {
		usage: createCursorUsageAccount(
			{
				id: "cursor-grok-4.6-medium",
				provider: "cursor",
				api: "cursor-agent",
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			} as Model<"cursor-agent">,
			output,
		),
		get currentTextBlock() {
			return textBlock;
		},
		get currentThinkingBlock() {
			return thinkingBlock;
		},
		get currentToolCall() {
			return toolCall;
		},
		firstTokenTime: undefined,
		setTextBlock: b => {
			textBlock = b;
		},
		setThinkingBlock: b => {
			thinkingBlock = b;
		},
		setToolCall: t => {
			toolCall = t;
		},
		setFirstTokenTime: () => {},
		execDispatchedToolCalls: new Set<string>(),
	};
}

/** `Record<string, Uint8Array>` is what the decoded `McpArgs.args` map holds. */
function encodeArgs(args: Record<string, unknown>): Record<string, Uint8Array> {
	const encoded: Record<string, Uint8Array> = {};
	const encoder = new TextEncoder();
	for (const [key, value] of Object.entries(args)) {
		encoded[key] = encoder.encode(typeof value === "string" ? value : JSON.stringify(value));
	}
	return encoded;
}

function started(id: string, name: string, args: Record<string, unknown>): InteractionUpdateView {
	return {
		message: {
			case: "toolCallStarted",
			value: {
				callId: id,
				toolCall: {
					tool: {
						case: "mcpToolCall",
						value: { args: { toolCallId: id, name, toolName: name, args: encodeArgs(args) } },
					},
				},
			},
		},
	};
}

/** `toolCallStarted` for a call whose arguments Cursor has not decided yet. */
function startedWithoutArgs(id: string, name: string): InteractionUpdateView {
	return {
		message: {
			case: "toolCallStarted",
			value: {
				callId: id,
				toolCall: {
					tool: {
						case: "mcpToolCall",
						value: { args: { toolCallId: id, name, toolName: name, args: {} } },
					},
				},
			},
		},
	};
}

/** `args_text_delta` is a cumulative snapshot of the args JSON, not a fragment. */
function partial(id: string, snapshot: string): InteractionUpdateView {
	return { message: { case: "partialToolCall", value: { callId: id, argsTextDelta: snapshot } } };
}

function completed(id: string, name: string, args: Record<string, unknown>): InteractionUpdateView {
	return {
		message: {
			case: "toolCallCompleted",
			value: {
				callId: id,
				toolCall: {
					tool: {
						case: "mcpToolCall",
						value: { args: { toolCallId: id, name, toolName: name, args: encodeArgs(args) } },
					},
				},
			},
		},
	};
}

/** Completion with no argument map, the shape a purely streamed call ends with. */
function completedBare(id: string): InteractionUpdateView {
	return { message: { case: "toolCallCompleted", value: { callId: id } } };
}

function mcpExecRequest(id: string, name: string, args: Record<string, unknown>) {
	return create(AgentServerMessageSchema, {
		message: {
			case: "execServerMessage",
			value: create(ExecServerMessageSchema, {
				id: 1,
				execId: `exec-${name}`,
				message: {
					case: "mcpArgs",
					value: create(McpArgsSchema, { name, toolName: name, toolCallId: id, args: encodeArgs(args) }),
				},
			}),
		},
	});
}

interface Turn {
	output: AssistantMessage;
	state: BlockState;
	stream: AssistantMessageEventStream;
	events: AssistantMessageEvent[];
	send: (update: InteractionUpdateView) => void;
	calls: () => ToolCall[];
	call: (id: string) => ToolCall | undefined;
	endEvents: () => Array<{ id: string; args: unknown }>;
}

function newTurn(): Turn {
	const output = cursorAssistantMessage();
	const stream = new AssistantMessageEventStream();
	const state = newBlockState(output);
	const events: AssistantMessageEvent[] = [];
	const push = stream.push.bind(stream);
	stream.push = (event: AssistantMessageEvent) => {
		events.push(event);
		return push(event);
	};
	const calls = () => output.content.filter((block): block is ToolCall => block.type === "toolCall");
	return {
		output,
		state,
		stream,
		events,
		send: update => processInteractionUpdate(update, output, stream, state),
		calls,
		call: id => calls().find(block => block.id === id),
		endEvents: () =>
			events
				.filter(event => event.type === "toolcall_end")
				.map(event => ({
					id: event.type === "toolcall_end" ? event.toolCall.id : "",
					args: event.type === "toolcall_end" ? event.toolCall.arguments : undefined,
				})),
	};
}

/** The captured order: both calls open, then both complete, in issue order. */
function twoCallBatch(turn: Turn): void {
	turn.send(partial(callId(0), ""));
	turn.send(started(callId(0), "set_cwd", { path: "/home/op/tmp", i: "Confirm session working directory" }));
	turn.send(partial(callId(1), ""));
	turn.send(started(callId(1), "eval", { language: "py", title: "harness smoke", code: "print('ok')" }));
	turn.send(completed(callId(0), "set_cwd", { path: "/home/op/tmp", i: "Confirm session working directory" }));
	turn.send(completed(callId(1), "eval", { language: "py", title: "harness smoke", code: "print('ok')" }));
}

describe("a Cursor tool-call batch", () => {
	it("keeps each call's arguments on the call that asked for them", () => {
		const turn = newTurn();
		twoCallBatch(turn);

		expect(turn.calls().map(call => call.id)).toEqual([callId(0), callId(1)]);
		expect(turn.call(callId(0))).toMatchObject({
			name: "set_cwd",
			arguments: { path: "/home/op/tmp", i: "Confirm session working directory" },
		});
		expect(turn.call(callId(1))).toMatchObject({
			name: "eval",
			arguments: { language: "py", title: "harness smoke", code: "print('ok')" },
		});
	});

	it("never leaves a call holding the empty object it opened with", () => {
		// The exact shape that reached the validator: `set_cwd` with `{}`, whose
		// second execution answered "path must be a string (was missing)" under an
		// id that already had a successful result.
		const turn = newTurn();
		twoCallBatch(turn);

		for (const call of turn.calls()) {
			expect(Object.keys(call.arguments as Record<string, unknown>).length).toBeGreaterThan(0);
		}
	});

	it("gives every call exactly one end event carrying its own arguments", () => {
		const turn = newTurn();
		twoCallBatch(turn);

		expect(turn.endEvents()).toEqual([
			{ id: callId(0), args: { path: "/home/op/tmp", i: "Confirm session working directory" } },
			{ id: callId(1), args: { language: "py", title: "harness smoke", code: "print('ok')" } },
		]);
	});

	it("keeps three calls apart, not just the first two", () => {
		// The pointer defect corrupts the NEXT call, so a two-call turn can be made
		// green by shifting the pointer one step. Three calls with distinct
		// arguments cannot.
		const turn = newTurn();
		turn.send(started(callId(0), "read", { path: "a.ts" }));
		turn.send(started(callId(1), "read", { path: "b.ts" }));
		turn.send(started(callId(2), "read", { path: "c.ts" }));
		turn.send(completed(callId(0), "read", { path: "a.ts" }));
		turn.send(completed(callId(1), "read", { path: "b.ts" }));
		turn.send(completed(callId(2), "read", { path: "c.ts" }));

		expect(turn.calls().map(call => call.arguments)).toEqual([{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }]);
	});

	it("accumulates interleaved argument snapshots into the buffer of the call each names", () => {
		const turn = newTurn();
		turn.send(startedWithoutArgs(callId(0), "bash"));
		turn.send(startedWithoutArgs(callId(1), "bash"));
		turn.send(partial(callId(0), '{"command":"echo '));
		turn.send(partial(callId(1), '{"command":"echo '));
		turn.send(partial(callId(0), '{"command":"echo one"}'));
		turn.send(partial(callId(1), '{"command":"echo two"}'));
		turn.send(completedBare(callId(0)));
		turn.send(completedBare(callId(1)));

		expect(turn.call(callId(0))?.arguments).toEqual({ command: "echo one" });
		expect(turn.call(callId(1))?.arguments).toEqual({ command: "echo two" });
	});

	it("completes the call the update names, leaving a later call open", () => {
		// `completed(A)` used to close whatever the pointer held, which was B, and
		// then B's own completion found nothing to close.
		const turn = newTurn();
		turn.send(started(callId(0), "read", { path: "a.ts" }));
		turn.send(started(callId(1), "read", { path: "b.ts" }));
		turn.send(completed(callId(0), "read", { path: "a.ts" }));

		expect(turn.endEvents()).toEqual([{ id: callId(0), args: { path: "a.ts" } }]);
		expect(getStreamingPartialJson(turn.call(callId(0)) as object)).toBeUndefined();
		// B is still open, so the loop can still tell a finished call from a
		// truncated one when the turn ends here.
		expect(getStreamingPartialJson(turn.call(callId(1)) as object)).toBe('{"path":"b.ts"}');
	});

	it("ignores an argument snapshot for a call that has no block", () => {
		// A `partialToolCall` arrives before its `toolCallStarted` on every turn.
		// Writing it onto whatever is current is the defect, not a fallback.
		const turn = newTurn();
		turn.send(started(callId(0), "read", { path: "a.ts" }));
		turn.send(partial(callId(9), '{"path":"stray.ts"}'));

		expect(turn.call(callId(0))?.arguments).toEqual({ path: "a.ts" });
		expect(turn.calls()).toHaveLength(1);
	});

	it("ignores a completion for a call that has no block", () => {
		const turn = newTurn();
		turn.send(started(callId(0), "read", { path: "a.ts" }));
		turn.send(completed(callId(9), "read", { path: "stray.ts" }));

		expect(turn.call(callId(0))?.arguments).toEqual({ path: "a.ts" });
		expect(turn.endEvents()).toEqual([]);
	});

	it("still routes an update that carries no call id to the open call", () => {
		// The negative control for id routing: a fixture or a server that omits
		// `call_id` must keep working through the pointer.
		const turn = newTurn();
		turn.send(startedWithoutArgs(callId(0), "bash"));
		turn.send({ message: { case: "partialToolCall", value: { argsTextDelta: '{"command":"echo one"}' } } });
		turn.send({ message: { case: "toolCallCompleted", value: {} } });

		expect(turn.call(callId(0))?.arguments).toEqual({ command: "echo one" });
		expect(turn.endEvents()).toEqual([{ id: callId(0), args: { command: "echo one" } }]);
	});

	it("keeps the open call reachable after an earlier call of the batch completed", () => {
		// Completing A must not detach the pointer from B, which is still open:
		// an update that carries no call id has nothing else to name, so clearing
		// the pointer on any completion silently drops B's arguments.
		const turn = newTurn();
		turn.send(startedWithoutArgs(callId(0), "read"));
		turn.send(startedWithoutArgs(callId(1), "bash"));
		turn.send(partial(callId(0), '{"path":"a.ts"}'));
		turn.send(completedBare(callId(0)));
		turn.send({ message: { case: "partialToolCall", value: { argsTextDelta: '{"command":"echo two"}' } } });
		turn.send(completedBare(callId(1)));

		expect(turn.call(callId(0))?.arguments).toEqual({ path: "a.ts" });
		expect(turn.call(callId(1))?.arguments).toEqual({ command: "echo two" });
	});

	it("keeps the arguments of a batch whose completions never arrive", () => {
		// An interrupted turn. `agent-loop.ts` reads the argument buffer to decide
		// whether a call's arguments finished; a call Cursor described in full at
		// its start frame has finished, and deleting it told the model a call it
		// had already run was never made.
		const turn = newTurn();
		turn.send(started(callId(0), "eval", { language: "py", code: "print(1)" }));
		turn.send(started(callId(1), "glob", { path: "*" }));

		expect(JSON.parse(getStreamingPartialJson(turn.call(callId(0)) as object) ?? "null")).toEqual({
			language: "py",
			code: "print(1)",
		});
		expect(JSON.parse(getStreamingPartialJson(turn.call(callId(1)) as object) ?? "null")).toEqual({ path: "*" });
	});

	it("lets streamed arguments supersede the ones its start frame carried", () => {
		// A seeded buffer is a complete JSON object, not a prefix. Appending a
		// streamed snapshot to it would produce two objects in one buffer, which
		// parses to nothing and loses both.
		const turn = newTurn();
		turn.send(started(callId(0), "bash", { command: "echo stale" }));
		turn.send(partial(callId(0), '{"command":"echo fresh"}'));
		turn.send(completedBare(callId(0)));

		expect(turn.call(callId(0))?.arguments).toEqual({ command: "echo fresh" });
	});

	it("stamps only the exec-dispatched call of a batch and keeps both sets of arguments", async () => {
		// The live shape: Cursor dispatches one call of the batch through the exec
		// channel (which runs it HERE and answers it) while the other stays the
		// agent loop's to run. Getting the arguments right and the stamp wrong
		// re-runs a side-effecting tool; getting the stamp right and the arguments
		// wrong runs the surviving call with a sibling's arguments.
		const turn = newTurn();
		const ran: string[] = [];
		const execHandlers = {
			async mcp(call: { toolCallId: string; toolName: string }) {
				ran.push(call.toolCallId);
				return {
					role: "toolResult",
					toolCallId: call.toolCallId,
					toolName: call.toolName,
					content: [{ type: "text", text: "ran once" }],
					isError: false,
					timestamp: 1,
				} satisfies ToolResultMessage;
			},
		} as unknown as CursorExecHandlers;
		const h2Request = { write: () => true } as unknown as Parameters<typeof handleServerMessage>[5];

		turn.send(started(callId(0), "set_cwd", { path: "/home/op/tmp" }));
		turn.send(started(callId(1), "eval", { language: "py", code: "print(1)" }));
		await handleServerMessage(
			mcpExecRequest(callId(1), "eval", { language: "py", code: "print(1)" }),
			turn.output,
			turn.stream,
			turn.state,
			new Map(),
			h2Request,
			execHandlers,
			undefined,
			[],
		);
		turn.send(completed(callId(0), "set_cwd", { path: "/home/op/tmp" }));
		turn.send(completed(callId(1), "eval", { language: "py", code: "print(1)" }));

		expect(ran).toEqual([callId(1)]);
		const byId = new Map(turn.calls().map(call => [call.id, call as ToolCall & CursorExecResolvedCarrier]));
		expect(byId.get(callId(0))?.[kCursorExecResolved]).toBeUndefined();
		expect(byId.get(callId(1))?.[kCursorExecResolved]).toBe(true);
		expect(byId.get(callId(0))?.arguments).toEqual({ path: "/home/op/tmp" });
		expect(byId.get(callId(1))?.arguments).toEqual({ language: "py", code: "print(1)" });
	});

	it("does not let a text block between two calls move the arguments", () => {
		// Cursor writes prose between calls of the same batch. The pointer was
		// cleared by neither, so this is a variant the pointer version also failed;
		// it stays because a future "close the open call when text starts" fix
		// would reintroduce the shift.
		const turn = newTurn();
		turn.send(started(callId(0), "read", { path: "a.ts" }));
		turn.send({ message: { case: "textDelta", value: { text: "reading both" } } });
		turn.send(started(callId(1), "read", { path: "b.ts" }));
		turn.send(completed(callId(0), "read", { path: "a.ts" }));
		turn.send(completed(callId(1), "read", { path: "b.ts" }));

		expect(turn.call(callId(0))?.arguments).toEqual({ path: "a.ts" });
		expect(turn.call(callId(1))?.arguments).toEqual({ path: "b.ts" });
	});
});
