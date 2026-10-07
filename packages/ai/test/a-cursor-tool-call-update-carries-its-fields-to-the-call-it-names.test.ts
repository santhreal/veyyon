/**
 * WHY. Each Cursor tool-call update carries fields that belong to exactly one
 * open call: the MCP argument map's own tool-call id, the wire call id every
 * later update is addressed by, a cumulative argument snapshot or a fragment
 * of one, a completion's argument map, a todo list. A field dropped on the way
 * leaves a call under the wrong id, sends a later update to no call at all, or
 * ends a call with arguments the wire already replaced.
 *
 * The class is "an update field that does not reach its block". The suite
 * drives the real state machine with both call kinds it opens (an MCP call and
 * a todo call) and every variant that addresses a call: the two argument-delta
 * variants are swept, not picked.
 *
 * What this suite does NOT catch: it drives `processInteractionUpdate`
 * directly, so it says nothing about the exec channel's own copy of a call
 * (the exec-channel suite owns that) or about which update order the transport
 * delivers.
 */
import { describe, expect, it } from "bun:test";
import type { InteractionUpdateView } from "@veyyon/ai/providers/cursor";
import {
	callId,
	completedBare,
	encodeArgs,
	newTurn,
	started,
	startedWithoutArgs,
	type Turn,
} from "./helpers/cursor-stream-harness";

/** The variants that stream a call's arguments; both take the same cumulative snapshot. */
const ARGUMENT_DELTAS = ["toolCallDelta", "partialToolCall"] as const;

/** `toolCallStarted` whose MCP argument map names its own tool-call id, apart from the wire call id. */
function startedUnderOwnId(wireId: string, toolCallId: string, args: Record<string, unknown>): InteractionUpdateView {
	return {
		message: {
			case: "toolCallStarted",
			value: {
				callId: wireId,
				toolCall: {
					tool: { case: "mcpToolCall", value: { args: { toolCallId, name: "read", args: encodeArgs(args) } } },
				},
			},
		},
	};
}

function argumentDelta(variant: (typeof ARGUMENT_DELTAS)[number], id: string, snapshot: string): InteractionUpdateView {
	return { message: { case: variant, value: { callId: id, argsTextDelta: snapshot } } };
}

interface TodoItem {
	id: string;
	content: string;
	status: number;
}

function todoUpdate(
	variant: "toolCallStarted" | "toolCallCompleted",
	id: string,
	todos: TodoItem[],
): InteractionUpdateView {
	return {
		message: {
			case: variant,
			value: { callId: id, toolCall: { tool: { case: "updateTodosToolCall", value: { args: { todos } } } } },
		},
	};
}

function completedWithArgs(id: string, args: Record<string, unknown>): InteractionUpdateView {
	return {
		message: {
			case: "toolCallCompleted",
			value: {
				callId: id,
				toolCall: {
					tool: { case: "mcpToolCall", value: { args: { toolCallId: id, name: "read", args: encodeArgs(args) } } },
				},
			},
		},
	};
}

function eventTypes(turn: Turn): string[] {
	return turn.events.map(event => event.type);
}

describe("a Cursor tool call opened while prose is streaming", () => {
	it("closes the open text and thinking blocks before it opens", () => {
		const turn = newTurn();
		turn.send({ message: { case: "textDelta", value: { text: "reading " } } });
		turn.send({ message: { case: "thinkingDelta", value: { text: "which file" } } });
		turn.send(started(callId(0), "read", { path: "src/app.ts" }));
		turn.send({ message: { case: "thinkingDelta", value: { text: "next" } } });

		expect(eventTypes(turn)).toEqual([
			"text_start",
			"text_delta",
			"thinking_start",
			"thinking_delta",
			"text_end",
			"thinking_end",
			"toolcall_start",
			"thinking_start",
			"thinking_delta",
		]);
		expect(turn.output.content.map(block => block.type)).toEqual(["text", "thinking", "toolCall", "thinking"]);
	});
});

describe("a Cursor MCP call whose argument map names its own tool-call id", () => {
	const wireId = callId(0);
	const toolCallId = "toolu_01ArgumentMapId";

	it("is stored under the argument map's id", () => {
		const turn = newTurn();
		turn.send(startedUnderOwnId(wireId, toolCallId, {}));

		expect(turn.calls().map(call => call.id)).toEqual([toolCallId]);
	});

	for (const variant of ARGUMENT_DELTAS) {
		it(`receives a ${variant} addressed by the wire call id`, () => {
			const turn = newTurn();
			turn.send(startedUnderOwnId(wireId, toolCallId, {}));
			turn.send(argumentDelta(variant, wireId, '{"path":"src/app.ts"}'));

			expect(turn.call(toolCallId)?.arguments).toEqual({ path: "src/app.ts" });
			expect(eventTypes(turn)).toEqual(["toolcall_start", "toolcall_delta"]);
		});
	}

	it("ends on a completion addressed by the wire call id", () => {
		const turn = newTurn();
		turn.send(startedUnderOwnId(wireId, toolCallId, { path: "src/app.ts" }));
		turn.send(completedBare(wireId));

		expect(turn.endEvents()).toEqual([{ id: toolCallId, args: { path: "src/app.ts" } }]);
		expect(turn.state.currentToolCall).toBeNull();
	});
});

describe("a Cursor MCP call's arguments", () => {
	for (const variant of ARGUMENT_DELTAS) {
		it(`extend with a ${variant} fragment after a snapshot replaced the started map`, () => {
			// The started map is a whole argument object, so the first snapshot that
			// does not extend it replaces it. From then on the buffer is a stream, and
			// a value that does not extend it is a fragment appended to it.
			const turn = newTurn();
			turn.send(started(callId(0), "read", { path: "a.ts" }));
			turn.send(argumentDelta(variant, callId(0), '{"path":"src/'));
			turn.send(argumentDelta(variant, callId(0), 'app.ts"}'));
			turn.send(completedBare(callId(0)));

			expect(turn.endEvents()).toEqual([{ id: callId(0), args: { path: "src/app.ts" } }]);
		});
	}

	it("come from the completion when none streamed", () => {
		const turn = newTurn();
		turn.send(startedWithoutArgs(callId(0), "read"));
		turn.send(completedWithArgs(callId(0), { path: "src/app.ts", limit: 40 }));

		expect(turn.endEvents()).toEqual([{ id: callId(0), args: { path: "src/app.ts", limit: 40 } }]);
	});
});

describe("a Cursor todo call", () => {
	const first: TodoItem[] = [{ id: "t1", content: "Read the config", status: 2 }];

	for (const variant of ARGUMENT_DELTAS) {
		it(`ignores a ${variant} addressed to it`, () => {
			const turn = newTurn();
			turn.send(todoUpdate("toolCallStarted", callId(1), first));
			turn.send(argumentDelta(variant, callId(1), '{"todos":[]}'));

			expect(turn.call(callId(1))?.arguments).toEqual({
				todos: [{ id: "t1", content: "Read the config", activeForm: "Read the config", status: "in_progress" }],
			});
			expect(eventTypes(turn)).toEqual(["toolcall_start"]);
		});
	}

	it("ends with the list its completion carries", () => {
		const turn = newTurn();
		turn.send(todoUpdate("toolCallStarted", callId(1), first));
		turn.send(
			todoUpdate("toolCallCompleted", callId(1), [
				{ id: "t1", content: "Read the config", status: 3 },
				{ id: "t2", content: "Patch the loader", status: 1 },
			]),
		);

		expect(turn.endEvents()).toEqual([
			{
				id: callId(1),
				args: {
					todos: [
						{ id: "t1", content: "Read the config", activeForm: "Read the config", status: "completed" },
						{ id: "t2", content: "Patch the loader", activeForm: "Patch the loader", status: "pending" },
					],
				},
			},
		]);
	});
});
