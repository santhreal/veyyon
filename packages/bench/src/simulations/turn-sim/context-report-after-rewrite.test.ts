/**
 * A pass that rewrites history mid-turn must re-anchor what the session reports
 * as live context.
 *
 * WHY THIS FILE EXISTS. While a prompt is in flight the session holds a pending
 * context snapshot: the prompt as submitted at run start. Until a step of the
 * current turn produces provider usage that snapshot IS the reported context,
 * and after a compaction it is the only thing left, because every earlier usage
 * anchor is hidden. So a pass that removes bytes from history without
 * re-anchoring it reports the bytes it just removed as still being on the wire.
 *
 * That is not only a stale gauge. The post-compaction headroom and retry-fit
 * checks measure the same figure, so an inflated residual makes maintenance
 * declare a dead-end over context that is already gone. The dead-end rescue knew
 * this and re-anchored after each of its two tiers, and the automatic dedup site
 * did too. Four rewrite paths did not: the threshold overflow prune, the
 * per-turn stale-result prune, `dropImages()`, and the shake/dedup tail every
 * `/shake` from both front ends goes through. The re-anchor now belongs to the
 * rewrite (`#afterHistoryRewrite`) instead of to whoever remembers to call it.
 *
 * WHAT THESE ROWS PROVE. There are two reported numbers a rewrite has to move,
 * and only one of them exists at a time.
 *
 * Mid-turn, a tool triggers the redundant-result dedup (the shake tail) and the
 * report is read at that exact moment, before and after. Reading it from inside
 * a tool is the point: the pending snapshot only exists while a prompt is in
 * flight, so a between-turns assertion cannot see that half at all.
 *
 * Between turns there is no snapshot, and the report is the provider's own
 * prompt count for the last response it sent. That count was computed over
 * bytes a rewrite has since removed, so it is not ground truth about the next
 * request: this is the `/shake` case, where an operator elides history and no
 * request follows to correct the figure. The row makes the last turn bill real
 * usage, since a simulation that never reports usage anchors on zero and could
 * not tell a stale count from a fresh one.
 *
 * NOT ASSERTED HERE. The tier-1 elide path of the dead-end rescue picks regions
 * by size against a savings floor no simulation-sized context reaches; the dedup
 * reaches the same tail through a trigger a simulation can build.
 */

import { afterEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@veyyon/agent-core";
import { createSimulation, type Simulation, scriptTurns, simTool } from "./harness";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** Heavy enough that dropping one copy moves an estimate by hundreds of tokens. */
const BODY = `export const value = compute(1234);\n`.repeat(400);

interface Reading {
	before: number | undefined;
	after: number | undefined;
	dropped: number;
}

function tools(reading: Reading): AgentTool[] {
	return [
		simTool("read", async () => ({ content: [{ type: "text", text: BODY }] })),
		simTool("dedupe_now", async () => {
			const session = sim?.session;
			if (!session) throw new Error("no session");
			reading.before = session.getContextUsage()?.tokens;
			reading.dropped = (await session.dedupeRedundantToolResults()).toolResultsDropped;
			reading.after = session.getContextUsage()?.tokens;
			return { content: [{ type: "text", text: "deduped" }] };
		}),
	];
}

/**
 * Isolate the dedup: the supersede pass would blank the older read on its own
 * rule and leave nothing redundant to find.
 */
const ISOLATE_DEDUP_SETTINGS = {
	"retry.enabled": false,
	"compaction.supersedeReads": false,
	"compaction.dropUseless": false,
};

describe("the context a session reports follows a history rewrite", () => {
	it("falls when the dedup elides a duplicate result while the turn is still in flight", async () => {
		const reading: Reading = { before: undefined, after: undefined, dropped: 0 };
		sim = await createSimulation({
			settings: ISOLATE_DEDUP_SETTINGS,
			tools: tools(reading),
			script: scriptTurns(
				turn => {
					turn.toolCall("read", { path: "src/a.ts" }, "read-1");
					turn.finish("toolUse");
				},
				turn => {
					turn.text("read once");
					turn.finish();
				},
				// The second prompt reads the same file again, then runs the dedup
				// from inside the SAME turn, which is when a snapshot is pending.
				turn => {
					turn.toolCall("read", { path: "src/a.ts" }, "read-2");
					turn.finish("toolUse");
				},
				turn => {
					turn.toolCall("dedupe_now", {}, "dedupe-1");
					turn.finish("toolUse");
				},
				turn => {
					turn.text("done");
					turn.finish();
				},
			),
		});

		await sim.session.prompt("read src/a.ts");
		await sim.session.prompt("read it again, then tidy up");

		// The row is only evidence if the dedup actually elided something and the
		// gauge was readable at both moments.
		expect(reading.dropped).toBe(1);
		expect(reading.before).toBeDefined();
		expect(reading.after).toBeDefined();
		const before = reading.before ?? 0;
		const after = reading.after ?? 0;
		expect(after).toBeLessThan(before);
		// Roughly the elided body: a report that moved by a handful of tokens would
		// be describing the placeholder swap, not the bytes that left the context.
		expect(before - after).toBeGreaterThan(1_000);
	});

	it("falls when a rewrite between turns outdates the provider's own prompt count", async () => {
		sim = await createSimulation({
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
					turn.text("read twice");
					// What a real provider reports for a prompt carrying both copies of
					// the body. Without it every simulated turn bills zero, the anchor
					// contributes nothing, and the row could not tell a stale anchor from
					// a fresh one.
					turn.usage({ input: 7_300, output: 12 });
					turn.finish();
				},
			),
		});

		await sim.session.prompt("read src/a.ts");
		await sim.session.prompt("read it again");

		// Between turns there is no pending snapshot, so the report is the provider's
		// own prompt count for the last response. This is the `/shake` case: the
		// operator elides history from the prompt and no request follows.
		const before = sim.session.getContextUsage()?.tokens ?? 0;
		expect(before).toBeGreaterThan(7_000);

		const dropped = (await sim.session.dedupeRedundantToolResults()).toolResultsDropped;
		expect(dropped).toBe(1);

		const after = sim.session.getContextUsage()?.tokens ?? 0;
		// The count the provider gave describes bytes that are no longer in the
		// session, so it is not ground truth about anything that will be sent next.
		expect(before - after).toBeGreaterThan(1_000);
	});
});
