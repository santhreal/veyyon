/**
 * The title request a session fires for itself, and whether it rides the
 * session's transport.
 *
 * WHY THIS FILE EXISTS. A session names itself by asking a model, and it does so
 * unattended: the first user message triggers one title request, and a replan
 * (the model calling `todo` with `op: "init"`) triggers another. Those requests
 * were built on a bare `completeSimple`, which reads no operator setting at all,
 * so each went out with NO stream idle watchdog, NO first-event watchdog, outside
 * `providers.maxInFlightRequests` and outside the per-provider concurrency cap,
 * while the turn beside it carried all four. Nothing could see it. A title still
 * arrived, and a title model that goes silent is a hang rather than a wrong
 * answer: the replan path holds a single in-flight latch for the whole request,
 * so one silent provider retires the refresh for the rest of the session, and the
 * subagent-label path fires one such request per spawned agent with nothing
 * bracketing the fan-out.
 *
 * WHAT IS ASSERTED. That the side request the provider served for the title is
 * the same request the SESSION's transport recorded, and that it carries the
 * operator's watchdog budgets. Those are two different claims and both are
 * needed: the scripted provider module is installed by api, so it serves a bare
 * request just as happily as a session-transported one. Being served proves
 * nothing about which transport carried it, and only `sessionRequests()` sees the
 * difference.
 *
 * NOT asserted: the first-input title (the interactive input controller owns that
 * call site and there is no TUI here) and the subagent label (a spawn is a
 * subprocess, which this harness does not run). Both take the same transport from
 * the same session accessor as the path this file drives, and the accessor is what
 * every call site names.
 *
 * RED PROOFS, measured. Three mutants, three results.
 *
 * Reverting the replan call site to a bare transport (drop the `completeImpl`
 * argument in `#refreshTitleAfterReplan`): 2 fail, 1 pass. The transport row sees
 * the provider serve one side request the session never recorded, and the budget
 * row sees that request carry no budget at all while the turns beside it carry
 * both.
 *
 * Making the seam ignore what it is handed (`const complete = completeSimple`):
 * the same 2 fail, 1 pass. One call site passing the transport is worth nothing if
 * the function drops it, so both halves are pinned.
 *
 * Ignoring the operator's `title.refreshOnReplan` (drop the guard in
 * `#scheduleReplanTitleRefresh`): 1 fail, 2 pass, and the one that fails is the
 * refresh-off row. That is what makes it a control rather than a duplicate: it can
 * fail, and while it holds, the request the other two rows watch is the title
 * request and not some other thing the session sends.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ONLINE_TINY_TITLE_MODEL_KEY } from "@veyyon/coding-agent/tiny/models";
import { TOOL } from "@veyyon/coding-agent/tools/builtin-names";
import { createSimulation, type Simulation, simTool } from "./harness";

/** What the title model answers with, and therefore what the session must end up named. */
const TITLE = "Resolver Investigation";

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

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/**
 * Run one prompt whose turn inits a todo list. That result is what the session
 * reads as a replan, and a replan is what schedules the title refresh.
 */
async function replanUnder(settings: Record<string, unknown>): Promise<Served[]> {
	const served: Served[] = [];
	sim = await createSimulation({
		settings: {
			"providers.tinyModel": ONLINE_TINY_TITLE_MODEL_KEY,
			...BUDGETS,
			...settings,
		},
		tools: [
			simTool(TOOL.todo, async () => ({
				content: [{ type: "text", text: "todo list initialized" }],
				details: {
					op: "init",
					phases: [{ name: "Implementation", tasks: [{ content: "fix the resolver", status: "pending" }] }],
				},
			})),
		],
		script: turn => {
			const tools = turn.context.tools?.length ?? 0;
			served.push({
				side: tools === 0,
				idle: turn.options?.streamIdleTimeoutMs,
				first: turn.options?.streamFirstEventTimeoutMs,
			});
			if (tools === 0) {
				turn.text(TITLE);
				turn.finish();
				return;
			}
			turn.usage({ input: 400, output: 40 });
			if (turn.call === 1) {
				turn.toolCall(TOOL.todo, { op: "init" }, "call_0");
				turn.finish("toolUse");
				return;
			}
			turn.text("looking at the resolver now");
			turn.finish();
		},
	});
	await sim.session.prompt("investigate the resolver bug");
	return served;
}

/**
 * The title refresh is fire and forget, so the turn can finish before it does.
 * Bounded, and the bound is part of the contract: a title that never arrives is a
 * hang, and this must fail as a named timeout rather than by hanging the suite.
 */
async function waitForTitle(simulation: Simulation): Promise<string> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const name = simulation.sessionManager.getSessionName();
		if (name) return name;
		await sleep(10);
	}
	throw new Error("title-request-transport: the session was never named");
}

function sideRequests(served: Served[]): Served[] {
	return served.filter(request => request.side);
}

describe("the title request a session fires for itself", () => {
	it("is a request the session's own transport carried", async () => {
		const served = await replanUnder({});
		const simulation = sim!;
		expect(await waitForTitle(simulation)).toBe(TITLE);

		// The provider served exactly one side request, and the session's transport
		// recorded that same one. A bare transport reaches the provider too, so the
		// two counts agreeing is the whole claim.
		expect(sideRequests(served).length).toBe(1);
		expect(simulation.sessionRequests().filter(request => request.tools === 0).length).toBe(1);
	});

	it("carries the operator's watchdog budgets, like the turn beside it", async () => {
		const served = await replanUnder({});
		expect(await waitForTitle(sim!)).toBe(TITLE);

		expect(sideRequests(served)[0]).toMatchObject(EXPECTED_BUDGETS);
		for (const request of served.filter(entry => !entry.side)) expect(request).toMatchObject(EXPECTED_BUDGETS);
	});

	it("is not sent at all when the operator turned the replan refresh off", async () => {
		const served = await replanUnder({ "title.refreshOnReplan": false });
		// Absence needs a bound of its own: give the refresh the window it would have
		// used, then assert it never took it.
		await sleep(150);

		expect(sideRequests(served)).toEqual([]);
		expect(sim!.sessionRequests().filter(request => request.tools === 0)).toEqual([]);
		expect(sim!.sessionManager.getSessionName()).toBeFalsy();
	});
});
