/**
 * Compaction landing INSIDE a tool chain, between two requests of one prompt.
 *
 * WHY THIS FILE EXISTS. `compaction.midTurnEnabled` is on by default, and it is
 * the only compaction site that fires while a turn is still open: the session has
 * emitted tool calls, taken their results, and is about to send the next request
 * when the history is rewritten under it. Everything that makes compaction
 * dangerous is worse here. The messages array being rewritten is the one the live
 * loop is holding, so a rewrite the loop does not adopt leaves the next request
 * carrying history that no longer exists. A cut between a tool call and its result
 * puts an unpaired call on the wire and the provider rejects every following
 * request. And the operator sees none of it: the turn simply stops working
 * halfway through the work it was doing.
 *
 * The existing coverage of this setting mocks the compaction engine and asserts
 * that a spy was or was not called. That cannot see a wire, so it cannot see any
 * of the above. Here a real summarization request is served by the scripted
 * provider and every request is inspected as the provider received it.
 *
 * WHAT IS ASSERTED. Where the summarization request sits relative to the chain's
 * own requests (the whole difference between the two arms of the setting); that
 * every request pairs each tool call with its result, the one after the mid-chain
 * rewrite included; that the chain finishes inside the prompt that started it;
 * and that the requests after the compaction carry the summary rather than the
 * history it replaced.
 *
 * BOTH ARMS RUN. With the setting off, the same chain of the same size must run
 * to its end uncompacted and compact once the turn is over, which is what proves
 * the on-arm is the setting working rather than the threshold firing wherever it
 * likes.
 *
 * NOT asserted: what the summary says, or how much it saved. That is the
 * compaction engine's own subject, and `keep-recent-budget.test.ts` measures the
 * size question.
 *
 * RED PROOFS, measured. (a) Returning early from `#maintainContextMidRun` as
 * though the setting were off reds the on-arm only (the chain runs all eight
 * rounds and the summarizer arrives after the last one, which is precisely the
 * off-arm's shape). (b) Ignoring a `midTurnEnabled: false` setting there reds the
 * off-arm only. The pair is what makes each arm evidence about the setting rather
 * than about the threshold. (c) Dropping the `activeMessages.splice(...)` that
 * hands the rewritten history back to the live loop reds the on-arm: the request
 * after the compaction carries the pre-compaction history, so the summary is
 * missing from the wire while the transcript says the session compacted.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createSimulation, type Simulation, simTool } from "./harness";
import { describeViolations, pairingViolations, turnViolations } from "./invariants";

const CONTEXT_WINDOW = 16_000;
/** Rounds one prompt's tool chain runs. Sized so the crossing lands mid-chain. */
const CHAIN_ROUNDS = 8;
const SUMMARY_TEXT = "SUMMARY-OF-THE-CHAIN";
const CHAIN_DONE = "chain done";

/**
 * A small window, an explicit trigger, and a local summarizer, so the
 * summarization is a request this simulation serves and can place in the order.
 */
const COMPACTING_CHAIN = {
	"compaction.enabled": true,
	"compaction.threshold": "12000",
	"compaction.keepRecentTokens": 2_000,
	"compaction.remote": false,
	"compaction.autoContinue": true,
	"retry.enabled": false,
} as const;

/**
 * Bulky tool output: about 2400 tokens a round, so eight rounds of one prompt
 * cross a 12000-token trigger around the fifth and leave several rounds to run
 * after the rewrite.
 */
const WORK = simTool("work", async () => ({
	content: [{ type: "text", text: `tool output. ${"payload chunk. ".repeat(700)}` }],
}));

/** One request as the provider received it. */
interface Request {
	readonly call: number;
	/** The summarization request sends no tools; a live chain request does. */
	readonly summarizer: boolean;
	readonly carriesSummary: boolean;
	readonly violations: readonly string[];
}

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/**
 * Run one prompt whose answer is a chain of {@link CHAIN_ROUNDS} tool calls,
 * with mid-turn compaction on or off, and report every request it produced.
 */
async function runChain(midTurnEnabled: boolean): Promise<Request[]> {
	const requests: Request[] = [];
	let round = 0;
	sim = await createSimulation({
		model: { contextWindow: CONTEXT_WINDOW },
		settings: { ...COMPACTING_CHAIN, "compaction.midTurnEnabled": midTurnEnabled },
		tools: [WORK],
		script: turn => {
			const carriesSummary = JSON.stringify(turn.context.messages).includes(SUMMARY_TEXT);
			if ((turn.context.tools?.length ?? 0) === 0) {
				requests.push({ call: turn.call, summarizer: true, carriesSummary, violations: [] });
				turn.text(SUMMARY_TEXT);
				turn.finish();
				return;
			}
			requests.push({
				call: turn.call,
				summarizer: false,
				carriesSummary,
				violations: describeViolations(`request ${turn.call}`, pairingViolations(turn.context.messages)),
			});
			round += 1;
			turn.usage({ input: 400, output: 40 });
			if (round < CHAIN_ROUNDS) {
				turn.toolCall("work", { round }, `call-${round}`);
				turn.finish("toolUse");
				return;
			}
			turn.text(CHAIN_DONE);
			turn.finish();
		},
	});
	await sim.session.prompt("start the chain");
	return requests;
}

function compactionEntries(simulation: Simulation): number {
	return simulation.sessionManager.getEntries().filter(entry => entry.type === "compaction").length;
}

describe("compaction inside a tool chain", () => {
	it("rewrites the history between two requests of the same chain, and the chain keeps going", async () => {
		const requests = await runChain(true);
		if (!sim) throw new Error("simulation missing");

		const summarizerIndex = requests.findIndex(request => request.summarizer);
		const chainRequests = requests.filter(request => !request.summarizer);
		// The rewrite happened while the turn was open: chain requests follow it.
		expect(summarizerIndex).toBeGreaterThan(0);
		expect(requests.slice(summarizerIndex + 1).some(request => !request.summarizer)).toBe(true);
		// One compaction, before the prompt resolved. A second would mean the
		// rewrite did not get the session back under its trigger.
		expect(compactionEntries(sim)).toBe(1);

		// The whole point: nothing the provider was sent was ever unpaired, least of
		// all the request built out of the rewritten history.
		expect(requests.flatMap(request => request.violations)).toEqual([]);
		expect(describeViolations("stored history", turnViolations(sim))).toEqual([]);

		// The requests after the rewrite carry the summary, and none before it do.
		expect(requests.slice(0, summarizerIndex).some(request => request.carriesSummary)).toBe(false);
		expect(requests.slice(summarizerIndex + 1).every(request => request.carriesSummary)).toBe(true);

		// The chain finished inside the prompt that started it: the eight rounds
		// were served, and the last one answered with text rather than a tool call.
		expect(chainRequests.length).toBe(CHAIN_ROUNDS);
		expect(sim.session.messages.filter(message => message.role === "toolResult").length).toBe(CHAIN_ROUNDS - 1);
		const lastAssistant = [...sim.session.messages].reverse().find(message => message.role === "assistant");
		expect(JSON.stringify(lastAssistant?.content ?? [])).toContain(CHAIN_DONE);
		expect(sim.session.isStreaming).toBe(false);
	});

	it("leaves the chain alone when the setting is off, and compacts once the turn is over", async () => {
		const requests = await runChain(false);
		if (!sim) throw new Error("simulation missing");

		const summarizerIndex = requests.findIndex(request => request.summarizer);
		// Non-vacuous: the same chain still crosses the trigger and still compacts.
		// It just waits for the turn to end, so no chain request follows the
		// summarization except the continuation the compaction itself schedules.
		expect(summarizerIndex).toBeGreaterThan(0);
		expect(compactionEntries(sim)).toBe(1);
		expect(requests.slice(0, summarizerIndex).filter(request => !request.summarizer).length).toBe(CHAIN_ROUNDS);
		expect(requests.slice(0, summarizerIndex).some(request => request.carriesSummary)).toBe(false);
		expect(requests.flatMap(request => request.violations)).toEqual([]);
		expect(describeViolations("stored history", turnViolations(sim))).toEqual([]);
	});
});
