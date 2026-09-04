/**
 * Auto-compaction fires, and the request that follows it is still valid.
 *
 * WHY THIS FILE EXISTS. Every other simulation in this directory runs with
 * `compaction.enabled: false`, because the harness turns it off so an unscripted
 * summarization call cannot appear in the middle of somebody's scenario. That
 * makes the whole subsystem invisible here, and it is the subsystem with the
 * worst failure mode: compaction rewrites what goes to the provider, it fires
 * unattended at the moment the session is largest, and if it cuts between a tool
 * call and the result answering it, every following request is rejected by the
 * provider rather than merely being shorter. The session cannot recover from that
 * by itself, and the operator sees a run that has stopped working.
 *
 * WHAT IS ASSERTED, and where. `turnViolations` judges STORED history, which is
 * not what a provider reads. Compaction only rewrites the outbound Context, so
 * the assertion that matters is made on the real thing: the scripted provider
 * captures `turn.context.messages` for every call it serves, and the request
 * that follows a compaction must pair every tool call with its result. A
 * transcript whose stored form is perfect can still put an unpaired `tool_use`
 * on the wire, and that is precisely the bug class this file exists to see.
 *
 * NOT asserted: how much the summary saved, what it says, or how many messages
 * survived. Those are the compaction engine's own decisions and its own tests.
 *
 * OBSERVED RED. Allowing a tool result to be a valid cut point (one line in
 * `findValidCutPoints`) reds two cells with "a result for emit (call-9-b)
 * answers a call that was never emitted", which is the exact wire shape a
 * provider rejects. That is the defect this file is for, and it is invisible to
 * every suite that runs with compaction switched off.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { Message } from "@veyyon/ai";
import { createSimulation, type ProviderScript, type Simulation, simTool } from "./harness";
import { describeViolations, pairingViolations, turnViolations } from "./invariants";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** Enough text to move the token estimate a long way in one turn. */
function bulk(words: number): string {
	return "bulk ".repeat(words);
}

/**
 * What the history looks like when the threshold is crossed.
 *
 * Each shape is three turns of the same kind, sized so the third crossing is
 * unavoidable. The tool-bearing shapes are the point: a cut that lands between
 * a call and its result is the failure, and it can only happen where calls exist.
 */
interface HistoryShape {
	readonly name: string;
	/** The turn a prompt is answered with. Every prompt is served by it once. */
	readonly turn: ProviderScript;
}

const HISTORY_SHAPES: readonly HistoryShape[] = [
	{
		name: "text only",
		turn: turn => {
			turn.text(`answer ${turn.call}. ${bulk(3500)}`);
			turn.finish();
		},
	},
	{
		name: "one call and its result",
		turn: turn => {
			turn.toolCall("emit", { size: "large" }, `call-${turn.call}`);
			turn.finish("toolUse");
		},
	},
	{
		name: "two calls in one turn",
		turn: turn => {
			turn.toolCall("emit", { size: "large" }, `call-${turn.call}-a`);
			turn.toolCall("emit", { size: "large" }, `call-${turn.call}-b`);
			turn.finish("toolUse");
		},
	},
	{
		name: "text and a call in the same turn",
		turn: turn => {
			turn.text(`preamble ${turn.call}. ${bulk(1500)}`);
			turn.toolCall("emit", { size: "large" }, `call-${turn.call}`);
			turn.finish("toolUse");
		},
	},
];

/**
 * What the summarizer does when compaction reaches it.
 *
 * A summary REPLACES the history it covers, so the two unhappy answers are not
 * edge cases: a failed summarization call and a summary that came back empty
 * both have to leave the session usable rather than shorter and broken.
 */
interface SummarizerBeat {
	readonly name: string;
	readonly serve: ProviderScript;
}

const SUMMARIZER_BEATS: readonly SummarizerBeat[] = [
	{
		name: "answers with a summary",
		serve: turn => {
			turn.text("SUMMARY: the operator asked three things and each was answered.");
			turn.finish();
		},
	},
	{
		name: "fails outright",
		serve: turn => {
			turn.fail("500 Internal Server Error: summarizer unavailable");
		},
	},
	{
		name: "answers with nothing at all",
		serve: turn => {
			turn.text("");
			turn.finish();
		},
	},
];

/**
 * A tool whose result is big enough to be worth compacting, and never
 * byte-identical to its own earlier results: identical results are elided by the
 * tier-0 dedup before compaction is considered, which would leave this file
 * asserting the dedup instead of the crossing.
 */
function emitTool() {
	let call = 0;
	return simTool("emit", async () => {
		call += 1;
		return { content: [{ type: "text", text: `result. ${bulk(3000)}call ${call}.` }] };
	});
}

/** One request as the provider received it: its messages, and how many tools it carried. */
interface CapturedRequest {
	readonly messages: Message[];
	readonly tools: number;
}

interface Capture {
	readonly requests: CapturedRequest[];
}

/**
 * Serve `shape` for every ordinary turn and `beat` for the summarization call,
 * recording every request as the provider received it.
 *
 * The summarization call is identified by what the loop ASKS FOR rather than by
 * counting calls: compaction is the only request that arrives with no tools at
 * all, and it carries the whole conversation as one synthesized user message.
 * Counting would silently drift the moment a cell costs an extra call.
 *
 * A shape that emits tool calls is served once per prompt and answered with
 * plain text on the continuation, because the loop calls the provider again with
 * the results: a script that emitted a call every time would never terminate,
 * and the turn would spin instead of crossing the threshold.
 */
function serveWithCapture(shape: HistoryShape, beat: SummarizerBeat, capture: Capture): ProviderScript {
	return async turn => {
		const tools = turn.context.tools?.length ?? 0;
		capture.requests.push({ messages: [...turn.context.messages], tools });
		if (tools === 0) {
			await beat.serve(turn);
			return;
		}
		if (turn.context.messages.at(-1)?.role === "toolResult") {
			turn.text(`done with ${turn.call}.`);
			turn.finish();
			return;
		}
		await shape.turn(turn);
	};
}

describe("a session that crosses the compaction threshold stays sendable", () => {
	it("covers every history shape against every summarizer answer", () => {
		expect(HISTORY_SHAPES.length).toBeGreaterThanOrEqual(4);
		expect(SUMMARIZER_BEATS.length).toBe(3);
		expect(new Set(HISTORY_SHAPES.map(shape => shape.name)).size).toBe(HISTORY_SHAPES.length);
	});

	for (const shape of HISTORY_SHAPES) {
		for (const beat of SUMMARIZER_BEATS) {
			it(`${shape.name}, summarizer ${beat.name}`, async () => {
				const cell = `${shape.name} / summarizer ${beat.name}`;
				const capture: Capture = { requests: [] };
				sim = await createSimulation({
					settings: {
						"retry.enabled": false,
						"compaction.enabled": true,
						"compaction.thresholdTokens": 12_000,
						"compaction.keepRecentTokens": 2_000,
					},
					model: { contextWindow: 16_000 },
					tools: [emitTool()],
					script: serveWithCapture(shape, beat, capture),
				});

				await sim.session.prompt("one");
				await sim.session.prompt("two");
				await sim.session.prompt("three");
				// A fourth prompt is what carries whatever compaction produced onto
				// the wire. Without it a broken cut is written down and never sent,
				// which is the version of this bug nobody notices until later.
				await sim.session.prompt("four");

				expect(describeViolations(cell, turnViolations(sim))).toEqual([]);
				const lastRequest = capture.requests.at(-1);
				expect(lastRequest).toBeDefined();
				expect(
					describeViolations(`${cell} (final request)`, pairingViolations(lastRequest?.messages ?? [])),
				).toEqual([]);
			});
		}
	}

	it("really did compact, and the summarizer really was asked", async () => {
		// The matrix is a set of absences again, so one cell states positively that
		// the threshold was crossed: an auto-compaction ran to completion and the
		// summarization request (the one with no tools) was served. Without this the
		// whole file would pass on a build where compaction never fires at all.
		const capture: Capture = { requests: [] };
		const shape = HISTORY_SHAPES[1] as HistoryShape;
		const beat = SUMMARIZER_BEATS[0] as SummarizerBeat;
		sim = await createSimulation({
			settings: {
				"retry.enabled": false,
				"compaction.enabled": true,
				"compaction.thresholdTokens": 12_000,
				"compaction.keepRecentTokens": 2_000,
			},
			model: { contextWindow: 16_000 },
			tools: [emitTool()],
			script: serveWithCapture(shape, beat, capture),
		});

		await sim.session.prompt("one");
		await sim.session.prompt("two");
		await sim.session.prompt("three");
		await sim.session.prompt("four");

		expect(sim.eventsOfType("auto_compaction_start").length).toBeGreaterThan(0);
		const finished = sim.eventsOfType("auto_compaction_end");
		expect(finished.length).toBeGreaterThan(0);
		expect(capture.requests.some(request => request.tools === 0)).toBe(true);
		expect(finished.some(event => !event.aborted)).toBe(true);
	});
});
