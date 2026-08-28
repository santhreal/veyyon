/**
 * WHY. `processInteractionUpdate` is a chain of `else if` over the name of one
 * variant of Cursor's `InteractionUpdate` oneof. A variant nobody wrote a
 * branch for falls off the end of that chain and is discarded in silence: no
 * error, no log the operator sees, no assertion anywhere. That is how a wire
 * update that carries real state — a summary, a step boundary, shell output —
 * becomes a feature the product does not have, and nobody finds out until a
 * turn behaves wrong for a reason no test describes.
 *
 * The defect class is a switch over an external union with no membership
 * check. Its members arrive from OUTSIDE this repository: Cursor adds a
 * variant to `agent.proto`, the generated descriptor grows a field, and every
 * suite that names its own list of update kinds stays green. So the member
 * list here is read from the generated protobuf descriptor at run time, and
 * the partition into handled and ignored is asserted by exact equality. A new
 * variant turns this suite RED until someone writes a branch for it or records
 * it as ignored on purpose.
 *
 * `ignored` is a decision with teeth: each ignored variant is driven through
 * the real state machine and asserted to change NOTHING — no content block, no
 * stream event, no usage. Start handling one and this suite goes red, which is
 * the point: handling it is a behavior change that belongs in a test.
 *
 * `turnEnded` is the load-bearing member of that set. It is the turn's only
 * completion signal and `streamCursor` owns it, so a branch here that ended
 * the turn would end it twice, and a turn that never receives one must not
 * report that it finished.
 *
 * What this suite does NOT catch: it drives the state machine directly, so it
 * says nothing about which variants the transport actually delivers, nor about
 * `streamCursor`'s own handling of `turnEnded`. It also pins one observable
 * consequence per handled variant, not that variant's full semantics — the
 * tool-call batch suite next door owns those.
 */
import { describe, expect, it } from "bun:test";
import type { InteractionUpdateView } from "@veyyon/ai/providers/cursor";
import type { AssistantMessageEvent } from "@veyyon/ai/types";
import { InteractionUpdateSchema } from "@veyyon/catalog/discovery/cursor-gen/agent_pb";
import { callId, completed, newTurn, partial, started, type Turn } from "./helpers/cursor-stream-harness";

/** The wire's own member list, read from the generated descriptor rather than retyped. */
function wireCases(): string[] {
	const oneof = InteractionUpdateSchema.oneofs.find(candidate => candidate.name === "message");
	if (!oneof) throw new Error("InteractionUpdate no longer declares a `message` oneof");
	return oneof.fields.map(field => field.localName).sort();
}

function eventTypes(turn: Turn): string[] {
	return turn.events.map(event => event.type);
}

/** Content blocks carry streaming marker symbols; compare the data they model. */
function blocks(turn: Turn): Array<Record<string, unknown>> {
	return turn.output.content.map(block => {
		if (block.type === "text") return { type: "text", text: block.text };
		if (block.type === "thinking") return { type: "thinking", thinking: block.thinking };
		return { type: block.type };
	});
}

/** One observable consequence per handled variant, asserted through the real machine. */
const HANDLED: Record<string, (turn: Turn) => void> = {
	textDelta: turn => {
		turn.send({ message: { case: "textDelta", value: { text: "half " } } });
		turn.send({ message: { case: "textDelta", value: { text: "a sentence" } } });

		expect(blocks(turn)).toEqual([{ type: "text", text: "half a sentence" }]);
		expect(eventTypes(turn)).toEqual(["text_start", "text_delta", "text_delta"]);
	},
	thinkingDelta: turn => {
		turn.send({ message: { case: "thinkingDelta", value: { text: "weighing " } } });
		turn.send({ message: { case: "thinkingDelta", value: { text: "options" } } });

		expect(blocks(turn)).toEqual([{ type: "thinking", thinking: "weighing options" }]);
		expect(eventTypes(turn)).toEqual(["thinking_start", "thinking_delta", "thinking_delta"]);
	},
	thinkingCompleted: turn => {
		turn.send({ message: { case: "thinkingDelta", value: { text: "done" } } });
		turn.send({ message: { case: "thinkingCompleted", value: {} } });

		expect(eventTypes(turn)).toEqual(["thinking_start", "thinking_delta", "thinking_end"]);
		expect(turn.state.currentThinkingBlock).toBeNull();
	},
	toolCallStarted: turn => {
		turn.send(started(callId(0), "read", { path: "src/app.ts" }));

		expect(turn.calls()).toHaveLength(1);
		expect(turn.calls()[0]?.name).toBe("read");
		expect(turn.calls()[0]?.arguments).toEqual({ path: "src/app.ts" });
	},
	partialToolCall: turn => {
		turn.send(started(callId(0), "read", {}));
		turn.send(partial(callId(0), '{"path":"src/app.ts"}'));

		expect(turn.call(callId(0))?.arguments).toEqual({ path: "src/app.ts" });
		expect(eventTypes(turn)).toContain("toolcall_delta");
	},
	toolCallDelta: turn => {
		turn.send(started(callId(0), "read", {}));
		turn.send({
			message: { case: "toolCallDelta", value: { callId: callId(0), argsTextDelta: '{"path":"src/b.ts"}' } },
		});

		expect(turn.call(callId(0))?.arguments).toEqual({ path: "src/b.ts" });
		expect(eventTypes(turn)).toContain("toolcall_delta");
	},
	toolCallCompleted: turn => {
		turn.send(started(callId(0), "read", { path: "src/app.ts" }));
		turn.send(completed(callId(0), "read", { path: "src/app.ts" }));

		expect(turn.endEvents()).toEqual([{ id: callId(0), args: { path: "src/app.ts" } }]);
	},
	tokenDelta: turn => {
		const before = turn.output.usage.output;
		turn.send({ message: { case: "tokenDelta", value: { tokens: 7 } } });

		expect(turn.output.usage.output).toBe(before + 7);
	},
};

/**
 * Variants the state machine deliberately drops. `turnEnded` is owned by
 * `streamCursor`; the rest carry no state the assistant message models today.
 */
const IGNORED = [
	"heartbeat",
	"shellOutputDelta",
	"stepCompleted",
	"stepStarted",
	"summary",
	"summaryCompleted",
	"summaryStarted",
	"turnEnded",
	"userMessageAppended",
] as const;

/** A payload shaped like something, so an accidental branch has data to act on. */
function ignoredUpdate(updateCase: string): InteractionUpdateView {
	return {
		message: {
			case: updateCase,
			value: { text: "payload the machine must not read", tokens: 99, callId: callId(0) },
		},
	};
}

describe("the Cursor interaction-update union", () => {
	it("is partitioned into handled and ignored with nothing left over", () => {
		// Read from the generated descriptor: a variant Cursor adds upstream shows
		// up here, in neither half, and this equality fails until someone decides.
		const decided = [...Object.keys(HANDLED), ...IGNORED].sort();

		expect(decided).toEqual(wireCases());
	});

	it("names no variant the wire does not declare", () => {
		// The other direction: a branch for a variant that was renamed or removed
		// upstream is dead code that no other assertion can see.
		const declared = new Set(wireCases());
		const unknown = [...Object.keys(HANDLED), ...IGNORED].filter(name => !declared.has(name)).sort();

		expect(unknown).toEqual([]);
	});

	it("declares every handled variant exactly once", () => {
		const overlap = IGNORED.filter(name => name in HANDLED);

		expect(overlap).toEqual([]);
	});
});

describe("a handled Cursor update", () => {
	for (const [updateCase, drive] of Object.entries(HANDLED)) {
		it(`changes the message when it is ${updateCase}`, () => {
			drive(newTurn());
		});
	}
});

describe("an ignored Cursor update", () => {
	for (const updateCase of IGNORED) {
		it(`leaves the turn untouched when it is ${updateCase}`, () => {
			const turn = newTurn();
			turn.send(ignoredUpdate(updateCase));

			expect(blocks(turn)).toEqual([]);
			expect(turn.events).toEqual([]);
			expect(turn.output.usage.output).toBe(0);
			expect(turn.output.stopReason).toBe("stop");
		});

		it(`does not disturb an open block when it is ${updateCase}`, () => {
			// The quieter failure: a branch that ends the current text or thinking
			// block as a side effect, splitting one block into two.
			const turn = newTurn();
			turn.send({ message: { case: "textDelta", value: { text: "before " } } });
			turn.send(ignoredUpdate(updateCase));
			turn.send({ message: { case: "textDelta", value: { text: "after" } } });

			expect(blocks(turn)).toEqual([{ type: "text", text: "before after" }]);
			expect(eventTypes(turn)).toEqual(["text_start", "text_delta", "text_delta"]);
		});
	}

	it("does not end the turn when it is turnEnded", () => {
		// `streamCursor` owns the only completion signal. A branch here would end
		// the turn twice, and a turn that never receives one must not report that
		// it finished.
		const turn = newTurn();
		turn.send(started(callId(0), "read", { path: "src/app.ts" }));
		turn.send({ message: { case: "turnEnded", value: {} } });

		expect(turn.endEvents()).toEqual([]);
		expect(turn.state.currentToolCall?.id).toBe(callId(0));
	});
});

describe("a Cursor update the machine cannot name", () => {
	it("is discarded rather than applied to whatever block is open", () => {
		const turn = newTurn();
		turn.send({ message: { case: "textDelta", value: { text: "kept" } } });
		turn.send({ message: { case: "aVariantFromAFutureAgentProto", value: { text: "dropped" } } });

		expect(blocks(turn)).toEqual([{ type: "text", text: "kept" }]);
	});

	it("survives an update with no oneof selected", () => {
		const turn = newTurn();
		turn.send({});
		turn.send({ message: {} });

		expect(blocks(turn)).toEqual([]);
		expect(turn.events).toEqual([]);
	});

	it("survives a selected variant carrying no value", () => {
		// The generated decoder yields an absent `value` for a variant whose
		// message has every field at its default, which is not the same as the
		// variant being absent.
		const turn = newTurn();
		turn.send({ message: { case: "textDelta" } });
		turn.send({ message: { case: "toolCallStarted" } });
		turn.send({ message: { case: "toolCallCompleted" } });
		turn.send({ message: { case: "tokenDelta" } });

		expect(turn.calls()).toEqual([]);
		expect(turn.output.usage.output).toBe(0);
		const kinds: AssistantMessageEvent["type"][] = eventTypes(turn) as AssistantMessageEvent["type"][];
		expect(kinds.filter(kind => kind === "toolcall_end")).toEqual([]);
	});
});
