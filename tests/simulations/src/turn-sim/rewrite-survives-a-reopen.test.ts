/**
 * An elision has to outlive the process that made it.
 *
 * WHY THIS FILE EXISTS. Every history rewrite (the redundant-result dedup, the
 * threshold overflow prune, the stale-result prune, `dropImages`, the shake tail
 * `/shake` runs) replaces a message's content in place: the entry keeps its id
 * and its position, and its body becomes a placeholder. The session then sends
 * the smaller history for the rest of its life, which is the whole point of the
 * pass, and the previous file in this directory pins the number it reports.
 *
 * A resume is the other half, and it is the half a user actually notices. The
 * bytes were elided to keep a long session under its window; if the rewrite
 * lives only in the running session's memory, then closing the session and
 * picking it up again silently restores every byte, and the very next request
 * ships the duplicates the operator already paid to remove. Nothing in the UI
 * says so: the transcript looks the same either way, and the only visible effect
 * is a context gauge that jumped back up and a window that fills again.
 *
 * The other half of the same question is compaction. A summary REPLACES the
 * history it covers and lives in an entry naming the first message still in
 * play, so a rebuild that walks past it resurrects the whole conversation the
 * summary exists to remove. `reload-fidelity.test.ts` runs its reopen with
 * compaction off and says so; this is the row for the other side of that
 * disclaimer.
 *
 * WHAT THESE ROWS PROVE. The wire, not the gauge, on both sides of a reopen.
 * Marker text makes each copy of a body countable in the outbound context, so
 * every assertion is a number of copies the provider was handed.
 *
 * The elision row reads three requests: two copies of the read body before the
 * dedup, one after it, and one again from a second session that read the
 * transcript back through `switchSession`, which is what `/resume` runs. Nothing
 * is copied from the first session's memory.
 *
 * The summary row crosses the threshold for real, answers the summarization
 * request (the one the loop asks for with no tools at all), then asserts the
 * request after it carries the summary once, fewer bodies than were emitted, and
 * fewer messages than the widest request that preceded the summarization. After
 * the reopen the same three hold and the live request is a PREFIX of the resumed
 * one, so the summary sits where the replaced history used to be rather than
 * beside it.
 *
 * MEASURED CONTROLS, applied to production code, run, and reverted.
 *   - `#afterHistoryRewrite` without its `sessionManager.rewriteEntries()` call:
 *     the elision row reds. That is the loss this file was written for.
 *   - the kept window starting at the head of the transcript instead of at
 *     `firstKeptEntryId`: only the summary row reds.
 *   - the rebuild never emitting the summary message: only the summary row reds.
 *   - `#afterHistoryRewrite` without its `agent.replaceMessages` call: NOTHING
 *     here reds, because the outbound context is rebuilt from the session
 *     entries on each request rather than from the agent's message array. That
 *     mutation reds two rows in `context-report-after-rewrite.test.ts`, which is
 *     where the live-view half belongs.
 *
 * NOT ASSERTED HERE. Which pass did the eliding. The dedup is the one trigger a
 * simulation-sized context can reach, and the four owners share
 * `#afterHistoryRewrite` and the same in-place placeholder swap, so persistence
 * is a property of the rewrite rather than of the pass that asked for it. The
 * summary row also says nothing about the bodies BEHIND the boundary: the
 * compaction tail elision has already blanked them, which is why the boundary is
 * pinned by a message count rather than by a byte count.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { createSimulation, type Simulation, scriptTurns, simTool } from "./harness";

let sim: Simulation | undefined;
let reopened: Simulation | undefined;

afterEach(async () => {
	await reopened?.dispose();
	reopened = undefined;
	await sim?.dispose();
	sim = undefined;
});

/** One occurrence per copy of the body, so copies are countable on the wire. */
const MARKER = "READ-BODY-MARKER";

/** Heavy enough that eliding one copy is worth hundreds of tokens. */
const BODY = `${MARKER}\n${`export const value = compute(1234);\n`.repeat(400)}`;

/**
 * Isolate the dedup: the supersede pass would blank the older read on its own
 * rule and leave nothing redundant to find.
 */
const ISOLATE_DEDUP_SETTINGS = {
	"retry.enabled": false,
	"compaction.supersedeReads": false,
	"compaction.dropUseless": false,
};

function countCopies(wire: string, marker: string = MARKER): number {
	return wire.split(marker).length - 1;
}

/** One occurrence per emitted tool result, countable on the wire. */
const EMITTED = "EMITTED-BODY-MARKER";

/** What the scripted summarizer answers with, countable the same way. */
const SUMMARY = "SUMMARY-BODY-MARKER";

/** The prompt the reopened session sends, recognized by the script. */
const RESUME_PROMPT = "remind me what the summary says";

function roles(wire: string): string[] {
	return (JSON.parse(wire) as Array<{ role: string }>).map(message => message.role);
}

describe("a history rewrite survives the session being reopened", () => {
	it("hands the reopened session the elided history, not the bytes it replaced", async () => {
		const wires: string[] = [];
		sim = await createSimulation({
			persist: true,
			settings: ISOLATE_DEDUP_SETTINGS,
			tools: [simTool("read", async () => ({ content: [{ type: "text", text: BODY }] }))],
			script: scriptTurns(
				turn => {
					turn.toolCall("read", { path: "src/a.ts" }, "read-1");
					turn.finish("toolUse");
				},
				turn => {
					turn.text("read once");
					turn.finish();
				},
				turn => {
					turn.toolCall("read", { path: "src/a.ts" }, "read-2");
					turn.finish("toolUse");
				},
				turn => {
					// The turn that carries BOTH copies: without this reading the row could
					// not tell an effective rewrite from a history that only ever held one.
					wires.push(JSON.stringify(turn.context.messages));
					turn.text("read twice");
					turn.finish();
				},
				// The tail repeats, so it serves both the turn after the dedup and the
				// first turn of the reopened session. Each records what the provider was
				// actually handed.
				turn => {
					wires.push(JSON.stringify(turn.context.messages));
					turn.text("recap");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("read src/a.ts");
		await sim.session.prompt("read it again");

		expect(wires).toHaveLength(1);
		expect(countCopies(wires[0] ?? "")).toBe(2);

		const dropped = (await sim.session.dedupeRedundantToolResults()).toolResultsDropped;
		expect(dropped).toBe(1);

		await sim.session.prompt("what did you read");
		expect(wires).toHaveLength(2);
		// The live session ships one copy: that is the rewrite doing its job.
		expect(countCopies(wires[1] ?? "")).toBe(1);

		reopened = await sim.reopen();
		await reopened.session.prompt("remind me what you read");

		expect(wires).toHaveLength(3);
		// A rewrite that lived only in the first session's memory shows up here as
		// two copies again, on a request the operator never asked to grow.
		expect(countCopies(wires[2] ?? "")).toBe(1);
	});

	/**
	 * The other rewrite a resume has to carry. A summary REPLACES the history it
	 * covers, and the replacement lives in a compaction entry that names the first
	 * entry still in play. A reopened session that rebuilds from the transcript
	 * without honouring it walks straight past the summary into the bytes the
	 * summary exists to remove, and the operator's next request is as large as the
	 * one that tripped the threshold in the first place.
	 */
	it("hands the reopened session the summary, not the history it replaced", async () => {
		const wires: string[] = [];
		const toolCounts: number[] = [];
		let emitted = 0;
		sim = await createSimulation({
			persist: true,
			settings: {
				"retry.enabled": false,
				"compaction.enabled": true,
				"compaction.thresholdTokens": 12_000,
				"compaction.keepRecentTokens": 2_000,
			},
			model: { contextWindow: 16_000 },
			tools: [
				simTool("emit", async () => {
					emitted += 1;
					// Never byte-identical: identical results are elided by the tier-0
					// dedup, which would make this row assert the dedup instead.
					return { content: [{ type: "text", text: `${EMITTED} ${emitted}. ${"bulk ".repeat(3_000)}` }] };
				}),
			],
			script: async turn => {
				const tools = turn.context.tools?.length ?? 0;
				toolCounts.push(tools);
				wires.push(JSON.stringify(turn.context.messages));
				// The summarization request is the one the loop asks for with no tools
				// at all; counting calls would drift the moment a turn costs one more.
				if (tools === 0) {
					turn.text(`SUMMARY: ${SUMMARY} the operator asked several things.`);
					turn.finish();
					return;
				}
				// The resumed prompt is answered with text: a fresh tool call there would
				// add a body of its own and the count would stop being about the summary.
				const last = turn.context.messages.at(-1);
				if (last?.role === "toolResult" || JSON.stringify(last ?? {}).includes(RESUME_PROMPT)) {
					turn.text(`done with ${turn.call}.`);
					turn.finish();
					return;
				}
				turn.toolCall("emit", { size: "large" }, `call-${turn.call}`);
				turn.finish("toolUse");
			},
		});

		await sim.session.prompt("one");
		await sim.session.prompt("two");
		await sim.session.prompt("three");
		await sim.session.prompt("four");

		// A row about what a summary replaced is worthless unless a summary happened.
		const finished = sim.eventsOfType("auto_compaction_end");
		expect(finished.some(event => !event.aborted)).toBe(true);

		const live = wires.at(-1) ?? "";
		expect(countCopies(live, SUMMARY)).toBe(1);
		const liveBodies = countCopies(live, EMITTED);
		// The summary covered something: fewer results on the wire than were emitted.
		expect(liveBodies).toBeLessThan(emitted);
		// And the rebuild sends the summary plus the kept window, not the whole path
		// with a summary bolted on: the post-summary request is shorter than the
		// widest request that preceded the summarization.
		const summarizerIndex = toolCounts.indexOf(0);
		expect(summarizerIndex).toBeGreaterThan(0);
		const widest = Math.max(...wires.slice(0, summarizerIndex).map(wire => roles(wire).length));
		expect(roles(live).length).toBeLessThan(widest);

		reopened = await sim.reopen();
		await reopened.session.prompt(RESUME_PROMPT);

		const resumed = wires.at(-1) ?? "";
		expect(countCopies(resumed, SUMMARY)).toBe(1);
		// A rebuild that ignored the compaction entry shows up here as the replaced
		// bodies coming back, on the first request after a resume.
		expect(countCopies(resumed, EMITTED)).toBe(liveBodies);
		// And it is the SAME conversation continued: the live request is a prefix of
		// the resumed one, so the summary sits where the replaced history used to be
		// rather than beside it.
		const liveRoles = roles(live);
		const resumedRoles = roles(resumed);
		expect(resumedRoles.slice(0, liveRoles.length)).toEqual(liveRoles);
		expect(resumedRoles.length).toBeGreaterThan(liveRoles.length);
	});
});
