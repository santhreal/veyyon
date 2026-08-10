/**
 * The two classifier requests a session fires for itself, and whether they ride
 * the session's transport.
 *
 * WHY THIS FILE EXISTS. A session asks a small model two questions on the
 * operator's behalf and never shows either one. `auto` thinking asks how hard the
 * prompt is, once per user turn, before the turn starts. Unexpected-stop
 * detection asks whether a reply that stopped without tool calls meant to
 * continue, at every settle a candidate stop reaches. Both were built on a bare
 * `completeSimple`, which reads no operator setting at all: NO stream idle
 * watchdog, NO first-event watchdog, outside `providers.maxInFlightRequests` and
 * outside the per-provider concurrency cap, while the turn beside them carried all
 * four. A silent provider on either one is a hang the operator watches with no
 * output: the difficulty question blocks the start of the turn (bounded only by
 * this session's own 4s abort, which fires and then still has to unwind), and the
 * settle question blocks the end of it.
 *
 * WHAT IS ASSERTED. For each classifier: that the side request the provider served
 * is the same request the SESSION's transport recorded, and that it carries the
 * operator's watchdog budgets. Those are two claims and both are needed. The
 * scripted provider module is installed by api, so it serves a bare request just
 * as happily as a session-transported one; being served proves nothing about which
 * transport carried it, and only `sessionRequests()` can see the difference.
 *
 * NOT asserted: the local (on-device) arm of either classifier, which does not
 * reach a provider transport at all, and the classification's effect on the turn
 * (the effort a difficulty answer selects, the continuation an unexpected stop
 * triggers) which other suites own.
 *
 * RED PROOFS, measured. Two mutants, one per call site, each dropping the
 * transport the session hands its classifier (`completeImpl:
 * this.#sideCompleteImpl`).
 *
 * Dropping it at the `classifyDifficulty` call site: 1 fail, 3 pass, and the one
 * that fails is the difficulty row. Dropping it at the `classifyUnexpectedStop`
 * call site: 1 fail, 3 pass, and the one that fails is the settle row. Each
 * mutant reds exactly its own row and leaves the other three green, so neither
 * row is carrying the other's claim.
 *
 * The two control rows (`auto` off, detection off) stay green under both mutants
 * on purpose: they exist to prove the side request the other rows watch is the
 * classifier's and not some other thing a prompt sends. Their power is the count
 * they assert, which was measured going red on the first run of this file, when
 * a scenario with no tools made every LIVE turn look like a side request.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { Effort } from "@veyyon/catalog/effort";
import { ONLINE_MEMORY_MODEL_KEY } from "@veyyon/coding-agent/tiny/models";
import { TOOL } from "@veyyon/coding-agent/tools/builtin-names";
import { createSimulation, type Simulation, simTool } from "./harness";

/** Operator watchdog budgets, in the shape the provider sees them (milliseconds). */
const BUDGETS = {
	"providers.streamIdleTimeoutSeconds": 0.5,
	"providers.streamFirstEventTimeoutSeconds": 0.4,
} as const;
const EXPECTED_BUDGETS = { idle: 500, first: 400 } as const;

/** One request as the provider received it. */
interface Served {
	/** No tools: a request the session made for itself rather than for the conversation. */
	readonly side: boolean;
	readonly idle: number | undefined;
	readonly first: number | undefined;
}

let sim: Simulation | undefined;

/**
 * One tool, never called. A turn with an empty tool list is indistinguishable
 * from a side request at the transport, so every scenario here offers one.
 */
const IDLE_TOOL = simTool(TOOL.todo, async () => ({ content: [{ type: "text", text: "nothing to do" }] }));

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/**
 * `auto` thinking: one prompt, and the difficulty question the session asks
 * before it starts the turn. The model declares an effort ladder because a
 * session offers `auto` nothing to pick without one, and the answer is a level
 * the ladder contains.
 */
async function autoThinkingPrompt(settings: Record<string, unknown>): Promise<Served[]> {
	const served: Served[] = [];
	sim = await createSimulation({
		settings: { ...BUDGETS, ...settings },
		model: { reasoning: true, efforts: [Effort.Low, Effort.Medium, Effort.High] },
		tools: [IDLE_TOOL],
		script: turn => {
			const tools = turn.context.tools?.length ?? 0;
			served.push({
				side: tools === 0,
				idle: turn.options?.streamIdleTimeoutMs,
				first: turn.options?.streamFirstEventTimeoutMs,
			});
			if (tools === 0) {
				turn.text("medium");
				turn.finish();
				return;
			}
			turn.usage({ input: 300, output: 20 });
			turn.text("the resolver reads the cached window first");
			turn.finish();
		},
	});
	sim.session.setThinkingLevel("auto");
	await sim.session.prompt("why does the resolver miss the cached window?");
	return served;
}

/**
 * Unexpected-stop detection: one turn that ends in text with no tool calls, which
 * is the candidate shape, and the question the session asks about it at settle.
 * The answer is "no" so the session settles rather than continuing.
 */
async function candidateStop(settings: Record<string, unknown>): Promise<Served[]> {
	const served: Served[] = [];
	sim = await createSimulation({
		settings: {
			"features.unexpectedStopDetection": true,
			"providers.unexpectedStopModel": ONLINE_MEMORY_MODEL_KEY,
			...BUDGETS,
			...settings,
		},
		tools: [IDLE_TOOL],
		script: turn => {
			const tools = turn.context.tools?.length ?? 0;
			served.push({
				side: tools === 0,
				idle: turn.options?.streamIdleTimeoutMs,
				first: turn.options?.streamFirstEventTimeoutMs,
			});
			if (tools === 0) {
				turn.text("no");
				turn.finish();
				return;
			}
			turn.usage({ input: 300, output: 20 });
			turn.text("Next I will read the resolver.");
			turn.finish();
		},
	});
	await sim.session.prompt("look at the resolver");
	return served;
}

function sideRequests(served: Served[]): Served[] {
	return served.filter(request => request.side);
}

function sessionSideRequests(simulation: Simulation): unknown[] {
	return simulation.sessionRequests().filter(request => request.tools === 0);
}

describe("the difficulty question `auto` thinking asks before every turn", () => {
	it("is a request the session's own transport carried, with its watchdog budgets", async () => {
		const served = await autoThinkingPrompt({});
		const side = sideRequests(served);

		// The provider served exactly one side request, the session's transport
		// recorded that same one, and it carries what the turn beside it carries.
		expect(side.length).toBe(1);
		expect(sessionSideRequests(sim!).length).toBe(1);
		expect(side[0]).toMatchObject(EXPECTED_BUDGETS);
		for (const request of served.filter(entry => !entry.side)) expect(request).toMatchObject(EXPECTED_BUDGETS);
	});

	it("is not asked at all on a concrete effort", async () => {
		// The control: without `auto` there is no question, so the side request the
		// rows above watch is the difficulty question and not some other thing the
		// session sends on a prompt.
		const served: Served[] = [];
		sim = await createSimulation({
			settings: { ...BUDGETS },
			model: { reasoning: true, efforts: [Effort.Low, Effort.Medium, Effort.High] },
			tools: [IDLE_TOOL],
			script: turn => {
				served.push({
					side: (turn.context.tools?.length ?? 0) === 0,
					idle: turn.options?.streamIdleTimeoutMs,
					first: turn.options?.streamFirstEventTimeoutMs,
				});
				turn.usage({ input: 300, output: 20 });
				turn.text("the resolver reads the cached window first");
				turn.finish();
			},
		});
		sim.session.setThinkingLevel(Effort.Medium);
		await sim.session.prompt("why does the resolver miss the cached window?");

		expect(sideRequests(served)).toEqual([]);
		expect(sessionSideRequests(sim)).toEqual([]);
	});
});

describe("the unexpected-stop question a session asks at settle", () => {
	it("is a request the session's own transport carried, with its watchdog budgets", async () => {
		const served = await candidateStop({});
		const side = sideRequests(served);

		expect(side.length).toBe(1);
		expect(sessionSideRequests(sim!).length).toBe(1);
		expect(side[0]).toMatchObject(EXPECTED_BUDGETS);
		for (const request of served.filter(entry => !entry.side)) expect(request).toMatchObject(EXPECTED_BUDGETS);
	});

	it("is not asked at all when the operator left detection off", async () => {
		const served = await candidateStop({ "features.unexpectedStopDetection": false });

		expect(sideRequests(served)).toEqual([]);
		expect(sessionSideRequests(sim!)).toEqual([]);
	});
});
