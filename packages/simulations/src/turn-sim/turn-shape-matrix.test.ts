/**
 * Every shape a turn can end in, crossed with everything it can contain.
 *
 * WHY THIS SUITE EXISTS. The hand-written simulations beside it each script one
 * misbehaviour: a truncated tool call, a provider that dies, a model that will not
 * stop. Every one of them was written after somebody suspected that specific failure.
 * What a real provider produces is a COMBINATION, and the combinations are where the
 * long tail lives: a `length` stop with a call still open, an error arriving after
 * two calls of which one names a tool that does not exist, a turn that emits nothing
 * at all and then fails.
 *
 * So the beats are enumerated instead of chosen. Content beats × stream endings is
 * the cross product below, every cell runs the real transport path (lazy stream,
 * watchdog, loop guard, retry classifier), and every cell is held to the same
 * invariants from `invariants.ts`. A new beat multiplies coverage rather than adding
 * one case.
 *
 * WHY THE ASSERTIONS ARE INVARIANTS AND NOT EXPECTED OUTPUTS. A cell has no single
 * correct transcript: whether a truncated call is dispatched or refused is a product
 * decision, and both answers are fine. What is never fine is a tool call nothing
 * answers, a result answering nothing, a duplicate call id, or a session left
 * streaming. Those are the four ways the next request is malformed or the turn is
 * lost, and they are what every cell asserts.
 *
 * WHY TERMINATION IS THE FIRST PROPERTY. Each cell awaits the prompt. A shape whose
 * failure mode is "never ends" fails by timing out, and no assertion in this file can
 * be satisfied by a stuck session.
 *
 * WHAT IT DOES NOT CATCH. Nothing about token accounting, cost, or what the assistant
 * says. It also runs one tool call per name at a time: interleaved parallel tool
 * dispatch is its own lane.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	createSimulation,
	type ProviderScript,
	type ScriptedTurn,
	type Simulation,
	scriptTurns,
	simTool,
} from "./harness";
import { describeViolations, toolCallsIn, turnViolations } from "./invariants";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** What the provider says before it ends the turn. */
interface ContentBeat {
	readonly name: string;
	readonly emit: (turn: ScriptedTurn) => void;
}

/** How the stream ends. `none` never ends it, so the idle watchdog has to. */
interface EndingBeat {
	readonly name: string;
	readonly end: (turn: ScriptedTurn) => void;
}

const CONTENT_BEATS: ContentBeat[] = [
	{ name: "silence", emit: () => {} },
	{ name: "text", emit: turn => turn.text("here is the plan") },
	{ name: "one-call", emit: turn => turn.toolCall("probe", { value: 1 }, "call-1") },
	{
		name: "text-then-call",
		emit: turn => {
			turn.text("running the probe");
			turn.toolCall("probe", { value: 2 }, "call-1");
		},
	},
	{
		name: "two-calls",
		emit: turn => {
			turn.toolCall("probe", { value: 3 }, "call-1");
			turn.toolCall("probe", { value: 4 }, "call-2");
		},
	},
	{ name: "failing-call", emit: turn => turn.toolCall("explode", {}, "call-1") },
	{ name: "unknown-tool", emit: turn => turn.toolCall("no-such-tool", {}, "call-1") },
	{ name: "truncated-call", emit: turn => turn.openToolCall("probe", '{"value":', "call-1") },
	{
		name: "duplicate-ids",
		emit: turn => {
			turn.toolCall("probe", { value: 5 }, "call-dup");
			turn.toolCall("probe", { value: 6 }, "call-dup");
		},
	},
];

const ENDING_BEATS: EndingBeat[] = [
	{ name: "stop", end: turn => turn.finish("stop") },
	{ name: "toolUse", end: turn => turn.finish("toolUse") },
	{ name: "length", end: turn => turn.finish("length") },
	{ name: "error", end: turn => turn.fail("the provider gave up") },
	{ name: "never-ends", end: () => {} },
];

/** The tools every cell offers. `explode` throws; `probe` answers. */
function matrixTools() {
	return [
		simTool("probe", async (_id, args) => ({ content: [{ type: "text", text: `probe ${JSON.stringify(args)}` }] })),
		simTool("explode", async () => {
			throw new Error("the tool refused");
		}),
	];
}

/**
 * The script for one cell: the shape on the first call, then a plain closing turn on
 * every call after it.
 *
 * The closing turn matters. A first turn that ends in `toolUse` sends the loop back
 * to the provider, and a cell that scripted only one call would be asserting the
 * behaviour of an exhausted script rather than of the shape.
 */
function cellScript(content: ContentBeat, ending: EndingBeat): ProviderScript {
	return scriptTurns(
		turn => {
			content.emit(turn);
			ending.end(turn);
		},
		turn => {
			turn.text("done");
			turn.finish("stop");
		},
	);
}

describe("every turn shape settles and leaves a well-formed transcript", () => {
	/** NON-VACUITY: the cross product is the size it claims to be. */
	it("enumerates the whole cross product", () => {
		expect(CONTENT_BEATS.length).toBeGreaterThanOrEqual(9);
		expect(ENDING_BEATS.length).toBeGreaterThanOrEqual(5);
		expect(CONTENT_BEATS.length * ENDING_BEATS.length).toBeGreaterThanOrEqual(45);
	});

	for (const content of CONTENT_BEATS) {
		for (const ending of ENDING_BEATS) {
			const shape = `${content.name} + ${ending.name}`;
			it(`settles: ${shape}`, async () => {
				sim = await createSimulation({
					settings: { "retry.enabled": false },
					tools: matrixTools(),
					script: cellScript(content, ending),
				});

				await sim.session.prompt("go");

				const violations = turnViolations(sim);
				expect(describeViolations(shape, violations)).toEqual([]);
			});
		}
	}

	/**
	 * A POSITIVE CONTROL for the invariant that matters most. The matrix above is a
	 * pile of "nothing went wrong" assertions, which is also what a broken invariant
	 * engine reports. So one cell is checked for what it POSITIVELY produced: a call
	 * that ran, with its answer in the transcript.
	 */
	it("really did run the tool it reports as answered", async () => {
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			tools: matrixTools(),
			script: cellScript(CONTENT_BEATS[2] as ContentBeat, ENDING_BEATS[1] as EndingBeat),
		});

		await sim.session.prompt("go");

		const calls = toolCallsIn(sim.session.messages);
		expect(calls.map(call => call.name)).toEqual(["probe"]);
		expect(turnViolations(sim)).toEqual([]);
		const results = sim.session.messages.filter(message => message.role === "toolResult");
		expect(results.length).toBe(1);
	});
});
