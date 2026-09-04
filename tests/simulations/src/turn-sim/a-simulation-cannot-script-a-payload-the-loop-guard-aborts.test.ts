/**
 * WHY: a simulation that scripts a degenerate payload measures a re-sample storm
 * and calls it a session.
 *
 * The shipped output-loop guard sits in this family's route (harness header:
 * `stream() -> loop guard -> streamBedrock`) and it watches every model, thinking
 * and visible text alike. Three compaction suites scripted their bulk as
 * `"reply chunk. ".repeat(300)` / `"bulk ".repeat(3500)`, which is not a long
 * answer but the exact verbatim loop the product aborts. While the guard was
 * Gemini-only they passed; the day it covered every model, every scripted turn
 * came back as a retryable stall with its usage discarded, nothing accumulated,
 * no compaction threshold was ever crossed, and eight rows went red asserting
 * `compactions: 1` against `0`. The defect was never in compaction.
 *
 * THE CLASS: any scripted provider payload the shipped guard would abort. The
 * harness runs the real `ThinkingLoopDetector` over every payload before it is
 * streamed and fails the turn with the detector's own reason, so the failure is
 * "your fixture is a loop" instead of a distant, plausible-looking assertion
 * about compaction. The set of payload methods is read off the object a script
 * is handed, so a new one is red here until it is locked or recorded as
 * carrying no model prose.
 *
 * WHAT THIS DOES NOT CATCH:
 *  - A loop assembled ACROSS payloads. The lock is per payload; the guard is per
 *    stream. Two halves that are each innocent still trip the guard, and the last
 *    arm pins that difference rather than pretending it away.
 *  - Whether the guard's thresholds are right. That is `packages/ai`'s suite.
 *  - A payload that is bulky and pointless but not a loop. Nothing rejects a
 *    fixture for being boring.
 */

import { afterEach, expect, it } from "bun:test";
import { ThinkingLoopDetector } from "@veyyon/ai/utils/thinking-loop";
import { bulkProse, createSimulation, type ScriptedTurn, type Simulation } from "./harness";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** The payload the three compaction suites used to script, verbatim. */
const HISTORIC_LOOP = `answer 1 ${"reply chunk. ".repeat(300)}`;

/** Payload methods: everything that hands the stream model-authored prose. */
const LOCKED = ["text", "thinking", "openThinking"] as const;

/**
 * The rest of the scripting surface, recorded by name. These carry structure
 * (tool calls, usage, stop reasons, local work), never prose the guard reads, so
 * they are deliberately not locked. A method that appears in neither list fails
 * the partition below, which is how a new prose method gets noticed.
 */
const NOT_PROSE = [
	"toolCall",
	"execResolvedToolCall",
	"openToolCall",
	"usage",
	"finish",
	"fail",
	"trackLocalWork",
	"onLocalWorkProbe",
] as const;

/** The `ScriptedTurn` a real script is handed, captured from a real turn. */
async function captureScriptedTurn(): Promise<ScriptedTurn> {
	const captured = Promise.withResolvers<ScriptedTurn>();
	const probe = await createSimulation({
		script: turn => {
			captured.resolve(turn);
			turn.finish();
		},
	});
	try {
		await probe.session.prompt("capture");
		return await captured.promise;
	} finally {
		await probe.dispose();
	}
}

/** The lock reports through the turn's own error path; this is what a suite sees. */
function lastTurnError(simulation: Simulation): string {
	const last = simulation.session.messages.at(-1);
	if (last?.role !== "assistant") return "";
	return last.errorMessage ?? "";
}

it("locks every payload method a script can reach, and no other", async () => {
	const turn = await captureScriptedTurn();
	const methods = Object.keys(turn)
		.filter(key => typeof (turn as unknown as Record<string, unknown>)[key] === "function")
		.sort();
	// Exact equality: a payload method added to the harness is red here until
	// someone decides which list it belongs in, which is the only thing that keeps
	// the lock from going quietly out of date.
	expect(methods).toEqual([...LOCKED, ...NOT_PROSE].sort());
});

it("fails a scripted payload the shipped guard would abort, naming the fixture", async () => {
	// Non-vacuity: the real detector agrees this payload is a loop, so the lock
	// refuses what the product refuses and not a stricter rule of its own.
	expect(new ThinkingLoopDetector().push(HISTORIC_LOOP)).toMatch(/repeated "reply chunk\." \d+× back-to-back/);

	const outcome: string[] = [];
	for (const method of LOCKED) {
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: turn => {
				turn[method](HISTORIC_LOOP);
				turn.finish();
			},
		});
		// The throw travels the provider's own error path, so the observable is a
		// failed turn rather than an unhandled rejection, and the prompt ENDS.
		await sim.session.prompt("go");
		const error = lastTurnError(sim);
		outcome.push(
			/scripted (text|thinking) is a degenerate loop the shipped guard aborts \(repeated/.test(error)
				? method
				: `${method}: ${error.slice(0, 80) || "not rejected"}`,
		);
		await sim.dispose();
		sim = undefined;
	}
	expect(outcome).toEqual([...LOCKED]);
});

it("passes the bulk helper at every volume the family scripts", () => {
	// The helper is the replacement for the loop, so it has to clear all three
	// detector shapes at the sizes the suites use: 520 words is a turn in the
	// growth arms, 2325 an answer in the interjection arms, and 6000 is past
	// anything scripted here, which is where a lexical stall shows up first.
	for (const words of [520, 2325, 6000]) {
		const detector = new ThinkingLoopDetector();
		const prose = bulkProse(words, `vol${words}`);
		expect({ words, detail: detector.push(prose) ?? detector.flush() }).toEqual({ words, detail: null });
	}
	// And two independently tagged answers in one stream stay clear of each other:
	// the near-duplicate detector compares paragraphs across the whole turn.
	const shared = new ThinkingLoopDetector();
	const first = shared.push(bulkProse(2325, "one"));
	const second = shared.push(bulkProse(2325, "two"));
	expect({ first, second, flush: shared.flush() }).toEqual({ first: null, second: null, flush: null });

	// Clearing the detector is not enough on its own. A filler of one word repeated
	// forever clears it too, purely because the anchor every 24th word cuts each
	// run to 161 chars against a 180-char floor: a 19-char margin, and a fixture
	// nobody would recognize as an answer. The helper's own contract is prose, so
	// bound the shape rather than the constant it happens to slip under.
	const words = bulkProse(2325, "shape").split(" ");
	let run = 1;
	let longest = 1;
	for (let i = 1; i < words.length; i += 1) {
		run = words[i] === words[i - 1] ? run + 1 : 1;
		if (run > longest) longest = run;
	}
	expect({ longestRepeat: longest, vocabulary: new Set(words).size }).toEqual({ longestRepeat: 1, vocabulary: 129 });
});

it("leaves a loop assembled across two innocent payloads to the guard, and the turn still ends", async () => {
	// Each half is under the verbatim floor (180 chars), so the per-payload lock
	// passes both. The guard's detector is per STREAM, so the concatenation trips
	// it -- the difference this file is honest about.
	const half = "reply chunk. ".repeat(7);
	expect(new ThinkingLoopDetector().push(half)).toBeNull();

	sim = await createSimulation({
		settings: { "retry.enabled": false },
		script: turn => {
			turn.text(half);
			turn.text(half);
			turn.finish();
		},
	});
	await sim.session.prompt("go");
	// Terminates. A guard that aborts without ending the stream is a hang, and a
	// hang here fails by timeout rather than by assertion.
	expect(sim.session.isStreaming).toBe(false);
	// And it was the guard, not the lock: the stall message is the product's.
	expect(lastTurnError(sim)).toMatch(/Thinking loop detected/);
});
