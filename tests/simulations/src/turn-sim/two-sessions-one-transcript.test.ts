/**
 * Two windows, one transcript, and both sets of turns have to be there afterwards.
 *
 * A session file is not owned exclusively: `--continue` twice, `/resume` on a
 * session another instance still has open, or a second terminal in the same
 * directory all end with two live sessions appending to one file. Each one
 * republishes the WHOLE file whenever it rewrites history (a dedup, a compaction,
 * an elision), and a body built only from the entries that window knows about
 * deletes the other window's turns. Nothing surfaces it: the window that loses
 * work is not the window that wrote the file, and a later reader sees a
 * transcript that simply never contained those turns.
 *
 * These rows drive the product path rather than the manager API: real turns, a
 * real rewrite, and a real resumed session over the same store. Each row asserts
 * the rewrite HAPPENED before asserting what survived it, because a row where
 * nothing was republished cannot fail for the reason it exists.
 *
 * MEASURED (mutants in `packages/coding-agent/src/session/session-manager.ts`,
 * each applied alone):
 * - `#fileBody()` drops the foreign-line loop (the pre-fix body): rows 1 and 2 red.
 * - `#refreshForeignLines()` returns before reading the file: rows 1 and 2 red.
 * The unit matrix beside this one is
 * `packages/coding-agent/test/session/two-managers-on-one-transcript.test.ts`,
 * which covers the id-ownership branches this file cannot reach through prompts.
 *
 * WHAT THIS DOES NOT CATCH: the append handle. A window keeps writing through the
 * writer it already opened after the other window replaces the file, which is a
 * different mechanism from the body being published, and the simulation's store
 * cannot express it: a memory writer appends by path, so it never holds a handle
 * on a file that has been replaced. That case belongs to the unit suite, on real
 * storage.
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

/** One occurrence per copy, so a redundant pair is countable. */
const MARKER = "READ-BODY-MARKER";
const BODY = `${MARKER}\n${`export const value = compute(1234);\n`.repeat(200)}`;

/** Isolate the dedup: the supersede pass would blank the older read on its own rule. */
const ISOLATE_DEDUP = {
	"retry.enabled": false,
	"compaction.supersedeReads": false,
	"compaction.dropUseless": false,
};

function readTool() {
	return simTool("read", async () => ({ content: [{ type: "text", text: BODY }] }));
}

/** Two reads of the same file, then text for every turn after them. */
function twoReadsThenText() {
	return scriptTurns(
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
			turn.finish();
		},
		// Repeats for every later turn, in this session and in the reopened one.
		turn => {
			turn.text("acknowledged");
			turn.finish();
		},
	);
}

/**
 * What a THIRD window would load: the transcript is written through the real
 * writer into the simulation's store, so the bytes are read back the way a new
 * process reads them rather than out of either live session's memory.
 */
async function storedTranscript(source: Simulation): Promise<string> {
	const fresh = await source.reopen();
	try {
		return fresh.sessionManager
			.getBranch()
			.map(entry => JSON.stringify(entry))
			.join("\n");
	} finally {
		await fresh.dispose();
	}
}

describe("two sessions on one transcript", () => {
	it("keeps the second window's turns when the first window rewrites history", async () => {
		sim = await createSimulation({
			persist: true,
			settings: ISOLATE_DEDUP,
			tools: [readTool()],
			script: twoReadsThenText(),
		});

		await sim.session.prompt("read src/a.ts");
		await sim.session.prompt("read it again");

		reopened = await sim.reopen();
		await reopened.session.prompt("a question from the second window");
		await reopened.sessionManager.flush();

		// The first window rewrites a history that never contained the line above.
		const dropped = (await sim.session.dedupeRedundantToolResults()).toolResultsDropped;
		expect(dropped).toBe(1);
		await sim.sessionManager.flush();

		const stored = await storedTranscript(sim);
		expect(stored).toContain("a question from the second window");
		expect(stored).toContain("read src/a.ts");
	});

	it("keeps the first window's later turns when the second window rewrites history", async () => {
		sim = await createSimulation({
			persist: true,
			settings: ISOLATE_DEDUP,
			tools: [readTool()],
			script: twoReadsThenText(),
		});

		await sim.session.prompt("read src/a.ts");
		await sim.session.prompt("read it again");

		reopened = await sim.reopen();
		// A turn the reopened window has no way to know about.
		await sim.session.prompt("a late question from the first window");
		await sim.sessionManager.flush();

		const dropped = (await reopened.session.dedupeRedundantToolResults()).toolResultsDropped;
		expect(dropped).toBe(1);
		await reopened.sessionManager.flush();

		expect(await storedTranscript(sim)).toContain("a late question from the first window");
	});
});
