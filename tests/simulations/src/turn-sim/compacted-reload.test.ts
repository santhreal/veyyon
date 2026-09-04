/**
 * A compacted session comes back compacted, and comes back complete.
 *
 * WHY THIS FILE EXISTS. Two suites next door each cover half of this. The
 * compaction suite proves the request AFTER a compaction is valid, all inside one
 * live session. The reload suite proves a stored conversation round-trips, with
 * compaction switched off. Neither says what an operator gets when they resume a
 * session that has already compacted, and that is the state a long session spends
 * most of its life in.
 *
 * The failure modes are opposite and both silent. A reload that rebuilt from the
 * raw entries would re-send the history compaction removed: the session that just
 * shrank itself to fit is back over the window on its first turn, and the
 * operator sees an overflow on a conversation that was working. A reload that
 * dropped the summary instead loses everything before the cut with no error at
 * all: the agent simply does not know what it was doing, which reads as the model
 * being stupid rather than as data loss.
 *
 * The rows:
 *   - the reopened session sends the summary and does NOT re-send the turns the
 *     compaction dropped;
 *   - the stored transcript still holds the pre-compaction history, because the
 *     transcript and the outbound context are two different lists and a reload
 *     must not settle the difference by throwing one away;
 *   - the request the reopened session sends is one a provider accepts: every
 *     tool call in it is answered;
 *   - the inherited summary is carried forward rather than recomputed, so a
 *     resume does not summarize a summary.
 *
 * WHAT THIS DOES NOT CATCH. The summary's content is the compaction engine's own
 * business, and it is read off the stored compaction entry rather than the
 * transcript's rendered text. Remote compaction (`compaction.remote`) hands the
 * job to the provider and is not exercised. Nothing here measures how much the
 * compaction saved.
 *
 * A row asserting that a REOPENED session compacts a second time was written and
 * then removed, because the measurement did not support it and would have frozen
 * a wrong claim: on a 16k window with compaction enabled, a session grown through
 * ordinary turns reports 11442, then 14299, then 17156 used tokens (past the
 * window itself, and well past the auto threshold) and never compacts, in a LIVE
 * session as much as in a reopened one. Only an oversized single prompt triggers
 * it, through the pre-prompt path. That is a product question rather than a
 * reload question and is tracked as `COMPACT-QUIET-1`; nothing in this file
 * claims either behaviour.
 *
 * RED PROOFS, observed rather than predicted.
 *   - `buildSessionContext` ignoring the compaction entry and rebuilding from the
 *     raw path (`} else if (compaction)` forced false): the summary row and the
 *     transcript row red, and only those. That is the "reload undid the
 *     compaction" failure, which is the expensive one.
 *   - No mutation was found that reds the no-re-summarize row, and it is recorded
 *     as a lock rather than a live guard: it fires if a resume ever starts
 *     summarizing inherited history again, and it catches nothing today.
 */

import { afterEach, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { createSimulation, type Simulation, simTool } from "./harness";
import { describeViolations, pairingViolations, toolCallsIn } from "./invariants";

let sim: Simulation | undefined;
let reopened: Simulation | undefined;

afterEach(async () => {
	await reopened?.dispose();
	await sim?.dispose();
	reopened = undefined;
	sim = undefined;
});

/**
 * Local summarization on a small window: the summarizer is a request this
 * simulation can see and count, where the remote path would hide it inside the
 * provider. The threshold is deliberately a token count rather than `auto`, so
 * the crossing happens on the prompt below and not two turns later.
 */
const COMPACTING = {
	"compaction.enabled": true,
	"compaction.thresholdTokens": 12_000,
	"compaction.keepRecentTokens": 2_000,
	"compaction.remote": false,
} as const;

/** Enough text to cross a 12k threshold in one prompt. */
const BULK = `bulk. ${"user bulk. ".repeat(6000)}`;

function texts(messages: readonly AgentMessage[]): string {
	return messages
		.map(message => {
			const content = (message as { content?: unknown }).content;
			if (typeof content === "string") return content;
			const blocks = Array.isArray(content) ? content : [];
			return blocks.map(block => (block as { text?: string }).text ?? "").join(" ");
		})
		.join("\n");
}

/**
 * A summarizer request carries no tools; a live turn always does, which is why
 * every simulation below registers the tool whether its script calls it or not.
 * Without that the two are indistinguishable and a live turn is counted as a
 * compaction.
 */
function isSummarizer(context: { tools?: unknown[] }): boolean {
	return (context.tools?.length ?? 0) === 0;
}

/** Registered by every simulation here, so a live turn is never mistaken for a summarizer. */
const WORK = simTool("work", async () => ({ content: [{ type: "text", text: "tool output" }] }));

it("sends the summary after a reload, and not the turns it replaced", async () => {
	const outbound: AgentMessage[][] = [];
	let summarizerCalls = 0;
	sim = await createSimulation({
		persist: true,
		model: { contextWindow: 16_000 },
		settings: { ...COMPACTING },
		tools: [WORK],
		script: turn => {
			if (isSummarizer(turn.context)) {
				summarizerCalls += 1;
				turn.text("SUMMARY-OF-EVERYTHING-BEFORE");
				turn.finish();
				return;
			}
			outbound.push([...turn.context.messages]);
			turn.usage({ input: 400, output: 40 });
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});

	await sim.session.prompt("MARKER-FIRST-QUESTION");
	await sim.session.prompt(BULK);
	expect(summarizerCalls).toBe(1);

	reopened = await sim.reopen();
	await reopened.session.prompt("MARKER-AFTER-RELOAD");

	const last = texts(outbound.at(-1) ?? []);
	// The summary is what carries the dropped history forward, so it has to be in
	// the request. The dropped turn must not be, or the reload undid the compaction
	// and the session is back over the window it just shrank to fit.
	expect(last).toContain("SUMMARY-OF-EVERYTHING-BEFORE");
	expect(last).toContain("MARKER-AFTER-RELOAD");
	expect(last).not.toContain("MARKER-FIRST-QUESTION");
	// No second summarization: the reopened session inherited a context that already
	// fits, so a reload must not pay for the same compaction twice.
	expect(summarizerCalls).toBe(1);
});

it("keeps the pre-compaction history in the stored transcript", async () => {
	sim = await createSimulation({
		persist: true,
		model: { contextWindow: 16_000 },
		settings: { ...COMPACTING },
		tools: [WORK],
		script: turn => {
			if (isSummarizer(turn.context)) {
				turn.text("SUMMARY-OF-EVERYTHING-BEFORE");
				turn.finish();
				return;
			}
			turn.usage({ input: 400, output: 40 });
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});

	await sim.session.prompt("MARKER-FIRST-QUESTION");
	await sim.session.prompt(BULK);

	reopened = await sim.reopen();

	// The transcript is the operator's record and the context is what the model
	// reads. Compaction shortens the second one; a reload that shortened the first
	// one too would delete the conversation the operator came back to read.
	const transcript = texts(reopened.sessionManager.buildSessionContext({ transcript: true }).messages);
	expect(transcript).toContain("MARKER-FIRST-QUESTION");
	expect(texts(reopened.session.messages)).not.toContain("MARKER-FIRST-QUESTION");
	// The summary is read off the stored compaction entry rather than out of the
	// transcript's rendered text: the transcript carries it as a compaction record
	// the TUI draws as a divider, not as a message with the summary inline.
	const summaries = reopened.sessionManager
		.getEntries()
		.filter(entry => entry.type === "compaction")
		.map(entry => (entry as { summary?: string }).summary ?? "");
	expect(summaries).toEqual(["SUMMARY-OF-EVERYTHING-BEFORE"]);
});

it("sends a request a provider accepts after reloading a compacted session", async () => {
	const outbound: AgentMessage[][] = [];
	sim = await createSimulation({
		persist: true,
		model: { contextWindow: 16_000 },
		settings: { ...COMPACTING },
		tools: [WORK],
		script: turn => {
			if (isSummarizer(turn.context)) {
				turn.text("SUMMARY-OF-EVERYTHING-BEFORE");
				turn.finish();
				return;
			}
			outbound.push([...turn.context.messages]);
			turn.usage({ input: 400, output: 40 });
			// Every live turn runs the tool, so the history the compaction cuts through
			// is full of pairs and a cut in the wrong place is expressible.
			if (turn.call % 2 === 1) {
				turn.toolCall("work", { step: turn.call }, `call-${turn.call}`);
				turn.finish("toolUse");
				return;
			}
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});

	await sim.session.prompt("MARKER-FIRST-QUESTION");
	await sim.session.prompt(BULK);

	reopened = await sim.reopen();
	await reopened.session.prompt("MARKER-AFTER-RELOAD");

	const last = outbound.at(-1) ?? [];
	expect(describeViolations("after reloading a compacted session", pairingViolations(last))).toEqual([]);
	// Non-vacuity: the wire really does carry calls here, so the pairing check has
	// something to be wrong about.
	expect(toolCallsIn(last).length).toBeGreaterThan(0);
});

it("does not re-summarize the history it inherited", async () => {
	let summarizerCalls = 0;
	sim = await createSimulation({
		persist: true,
		model: { contextWindow: 16_000 },
		settings: { ...COMPACTING },
		tools: [WORK],
		script: turn => {
			if (isSummarizer(turn.context)) {
				summarizerCalls += 1;
				turn.text(`SUMMARY-${summarizerCalls}`);
				turn.finish();
				return;
			}
			turn.usage({ input: 400, output: 40 });
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});

	await sim.session.prompt("MARKER-FIRST-QUESTION");
	await sim.session.prompt(BULK);
	expect(summarizerCalls).toBe(1);

	reopened = await sim.reopen();
	await reopened.session.prompt("a short question");
	await reopened.session.prompt("another short question");

	// The compaction is a fact in the transcript, so the summary it produced is
	// carried forward rather than recomputed. A reopened session that summarized
	// again would be paying a second time for history it already collapsed, and
	// each pass summarizes a summary, which is how a resumed conversation loses
	// detail it still had on disk.
	expect(summarizerCalls).toBe(1);
	expect(reopened.sessionManager.getEntries().filter(entry => entry.type === "compaction").length).toBe(1);
});
