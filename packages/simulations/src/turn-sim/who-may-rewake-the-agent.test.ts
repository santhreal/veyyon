/**
 * Settle-time re-invocation simulations: who may wake the agent after it stops.
 *
 * WHY THIS FILE EXISTS. The operator symptom is a turn that ends, and then the
 * model starts talking again on its own. Sometimes right after a reply that
 * asked the user a question, sometimes not, never the same way twice. The cause
 * is not one bug: it is that SEVERAL independent guards in the `agent_end` tail
 * can each schedule another agent turn, they were written at different times,
 * and each decided on its own whether a reply that hands the turn back to the
 * user is a reply it may talk over. Which one was armed decided what happened,
 * and nothing in the suite could see the disagreement, because every existing
 * test drove one guard at a time.
 *
 * So this file does not test a guard. It enumerates the routes from
 * {@link SETTLE_CONTINUATION_POLICY} at run time and holds EVERY one of them to
 * the same two facts, with the same reply text:
 *
 *   - a reply that asks the user something produces NO further provider call;
 *   - the identical setup with a statement instead DOES produce one.
 *
 * The second half is what makes the first half evidence. Without it a route that
 * silently failed to arm, or that cannot fire in a simulation at all, would pass
 * the "stays quiet" assertion for the wrong reason, and the suite would report
 * green over a guard it never exercised.
 *
 * The route table is the class boundary. `ROUTE_RIGS` is typed as a total
 * `Record<SettleContinuationRoute, RouteRig>`, so a route added to the policy
 * without a scenario here does not compile, and a rig left behind for a route
 * that no longer exists fails the coverage assertion below. A new guard cannot
 * be added to the settle tail and quietly inherit "may talk over the user".
 *
 * Determinism: no sleeps and no clock reads. Every assertion is a count of
 * scripted provider calls after `session.prompt()` has resolved, which the
 * session only does once its post-prompt continuations have drained. A route
 * that re-wakes forever fails by test timeout rather than by a late assertion.
 *
 * WHAT THIS DOES NOT CATCH, stated so nobody reads it as more than it is.
 * The routes are enumerated FROM the policy, so a guard that schedules a
 * continuation without consulting the policy at all is invisible here: it owns
 * no route id to enumerate. That hole is what produced the defect in the first
 * place, and only one thing closes it, which is every settle continuation
 * passing through a single choke point that demands a route. Until then, adding
 * a `#scheduleAgentContinue` call to the `agent_end` tail is a change this file
 * cannot see. It also does not test the vocabulary of the tail walk (a question
 * opener dropped from `QUESTION_OPENERS` shows up here only for the one phrasing
 * these scenarios use), and the empty-stop bound is asserted as termination plus
 * a loose ceiling rather than the exact cap, which is module-private.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { AgentTool } from "@veyyon/agent-core";
import {
	SETTLE_CONTINUATION_POLICY,
	type SettleContinuationRoute,
} from "@veyyon/coding-agent/session/settle-continuation";
import * as unexpectedStopClassifier from "@veyyon/coding-agent/session/unexpected-stop-classifier";
import { TOOL } from "@veyyon/coding-agent/tools/builtin-names";
import { createSimulation, type ProviderScript, type Simulation, scriptTurns, simTool } from "./harness";

let sim: Simulation | undefined;
let restoreStub: (() => void) | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
	restoreStub?.();
	restoreStub = undefined;
});

/**
 * A reply that hands the turn back to the user, and one that does not.
 *
 * Both are one line, so the two runs of a route differ in nothing but whether
 * the sentence is a question. The question opens with a word the detector's
 * vocabulary carries and ends in a question mark; the statement does neither.
 */
const QUESTION_REPLY = "Which storage backend should this use?";
const STATEMENT_REPLY = "The change is in place.";

/** Everything one settle route needs in order to want another turn. */
interface RouteRig {
	/** Settings that make the route live. */
	settings?: Record<string, unknown>;
	/** Tools the route's precondition or its lead turns need. */
	tools?: AgentTool[];
	/** Turns the model takes before the reply that settles. */
	lead?: ProviderScript[];
	/** State the session must be in before the prompt lands. */
	arm?: (simulation: Simulation) => void;
	/** Installed before the prompt; restored in `afterEach`. */
	stub?: () => () => void;
	/** Extra facts the two runs must show, beyond the call counts. */
	assertHeld?: () => void;
}

/** A `write` result the verification ledger reads as a real mutation. */
const writeTool = simTool("write", async () => ({
	content: [{ type: "text", text: "wrote 1 file" }],
	details: { resolvedPath: "/tmp/simulation/file.ts" },
}));

/**
 * Plan-mode convergence refuses to force a decision unless both decision tools
 * are registered, so the rig registers them. They are never called: the scripted
 * provider answers with text, which is exactly the turn plan mode objects to.
 */
const planDecisionTools = [
	simTool(TOOL.ask, async () => ({ content: [{ type: "text", text: "asked" }] })),
	simTool(TOOL.resolve, async () => ({ content: [{ type: "text", text: "resolved" }] })),
];

let classifierCalls = 0;

const ROUTE_RIGS: Record<SettleContinuationRoute, RouteRig> = {
	"rewind-checkpoint": {
		arm: simulation => {
			simulation.session.setCheckpointState({
				checkpointMessageCount: simulation.session.messages.length,
				checkpointEntryId: null,
				startedAt: new Date(0).toISOString(),
			});
		},
	},
	"plan-mode-decision": {
		tools: planDecisionTools,
		arm: simulation => {
			simulation.session.setPlanModeState({
				enabled: true,
				planFilePath: "local://PLAN.md",
				workflow: "parallel",
			});
		},
	},
	"todo-reminder": {
		arm: simulation => {
			simulation.session.setTodoPhases([
				{ name: "Implementation", tasks: [{ content: "Wire the settle gate", status: "pending" }] },
			]);
		},
	},
	"verification-evidence": {
		tools: [writeTool],
		// The ledger only owes a reminder for a mutation landed in THIS user turn,
		// so the mutation is a real tool call inside the same prompt rather than
		// pre-seeded state.
		lead: [
			turn => {
				turn.toolCall("write", { path: "/tmp/simulation/file.ts", content: "x" });
				turn.finish("toolUse");
			},
		],
	},
	"unexpected-stop-retry": {
		settings: { "features.unexpectedStopDetection": true, "providers.unexpectedStopModel": "online" },
		// The classifier is an out-of-process model call, i.e. the same category of
		// seam as the scripted provider transport: stubbed so the scenario decides
		// the verdict instead of a network round trip. It answers YES for BOTH
		// replies, which is the point. The ghost was the classifier reading a
		// question to the user as a turn the model abandoned mid-thought, and the
		// fix must not depend on it answering differently.
		stub: () => {
			classifierCalls = 0;
			const spy = spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockImplementation(async () => {
				classifierCalls += 1;
				return true;
			});
			return () => spy.mockRestore();
		},
		assertHeld: () => {
			// Ordering claim, not a nicety: the gate is checked BEFORE the classifier,
			// so a reply that asks the user something costs no classifier call at all.
			expect(classifierCalls).toBe(0);
		},
	},
};

const ROUTES = Object.keys(SETTLE_CONTINUATION_POLICY) as SettleContinuationRoute[];

/**
 * Drive one route to its settle and report how many provider calls it took.
 *
 * `replies` are the turns from the settle onward. A single question reply is the
 * held case; a statement followed by a question is the fired case, where the
 * question is what ends the chain (a route with no reminder budget of its own
 * would otherwise re-wake on every settle forever, and the run would hang).
 */
async function runRoute(route: SettleContinuationRoute, replies: string[]): Promise<number> {
	const rig = ROUTE_RIGS[route];
	restoreStub = rig.stub?.();
	sim = await createSimulation({
		settings: { "retry.enabled": false, ...rig.settings },
		...(rig.tools ? { tools: rig.tools } : {}),
		script: scriptTurns(
			...(rig.lead ?? []),
			...replies.map(
				(reply): ProviderScript =>
					turn => {
						turn.text(reply);
						turn.finish();
					},
			),
		),
	});
	rig.arm?.(sim);
	await sim.session.prompt("do the thing");
	expect(sim.session.isStreaming).toBe(false);
	return sim.providerCalls();
}

describe("every settle continuation route defers to a question", () => {
	it("has a scenario for each route the policy declares", () => {
		// The policy is the authority; this only catches a rig left behind for a
		// route that was removed. A route ADDED without a rig fails at compile time
		// because ROUTE_RIGS is a total Record over the union.
		expect(Object.keys(ROUTE_RIGS).sort()).toEqual([...ROUTES].sort());
	});

	it("declares every route as holding for the user, or says why not", () => {
		// A row that does not hold is legal, but it must be a decision someone
		// wrote down. `why` is the field that decision lives in.
		for (const route of ROUTES) {
			const rule = SETTLE_CONTINUATION_POLICY[route];
			expect(rule.why.length).toBeGreaterThan(40);
		}
	});

	for (const route of ROUTES) {
		const holds = SETTLE_CONTINUATION_POLICY[route].holdsForUserAnswer;
		const lead = ROUTE_RIGS[route].lead?.length ?? 0;

		it(`${route}: fires on a statement, so the quiet run below is evidence`, async () => {
			const calls = await runRoute(route, [STATEMENT_REPLY, QUESTION_REPLY]);
			expect(calls).toBe(lead + 2);
		});

		it(`${route}: ${holds ? "schedules nothing over a question" : "still fires over a question"}`, async () => {
			const calls = await runRoute(route, [QUESTION_REPLY]);
			expect(calls).toBe(holds ? lead + 1 : lead + 2);
			ROUTE_RIGS[route].assertHeld?.();
		});
	}
});

describe("all routes armed at once", () => {
	/**
	 * The original defect was not one guard: it was several, disagreeing. A reply
	 * that asks the user something must survive every route being armed
	 * simultaneously, which is the state a real session reaches routinely (an open
	 * checkpoint, an unfinished board, an unproven edit).
	 */
	async function armEverything(replies: string[]): Promise<number> {
		classifierCalls = 0;
		const spy = spyOn(unexpectedStopClassifier, "classifyUnexpectedStop").mockImplementation(async () => {
			classifierCalls += 1;
			return true;
		});
		restoreStub = () => spy.mockRestore();
		sim = await createSimulation({
			settings: {
				"retry.enabled": false,
				"features.unexpectedStopDetection": true,
				"providers.unexpectedStopModel": "online",
			},
			tools: [writeTool, ...planDecisionTools],
			script: scriptTurns(
				turn => {
					turn.toolCall("write", { path: "/tmp/simulation/file.ts", content: "x" });
					turn.finish("toolUse");
				},
				...replies.map(
					(reply): ProviderScript =>
						turn => {
							turn.text(reply);
							turn.finish();
						},
				),
			),
		});
		sim.session.setCheckpointState({
			checkpointMessageCount: sim.session.messages.length,
			checkpointEntryId: null,
			startedAt: new Date(0).toISOString(),
		});
		sim.session.setTodoPhases([
			{ name: "Implementation", tasks: [{ content: "Wire the settle gate", status: "pending" }] },
		]);
		await sim.session.prompt("do the thing");
		expect(sim.session.isStreaming).toBe(false);
		return sim.providerCalls();
	}

	it("leaves a question alone, and spends no classifier call on it", async () => {
		expect(await armEverything([QUESTION_REPLY])).toBe(2);
		expect(classifierCalls).toBe(0);
	});

	it("answers a statement with exactly one continuation, not one per route", async () => {
		// Every route is armed, so an unguarded tail would stack their reminders and
		// wake the model repeatedly. The tail returns after the first route that
		// schedules, so a statement costs ONE extra turn no matter how many routes
		// were owed one.
		expect(await armEverything([STATEMENT_REPLY, QUESTION_REPLY])).toBe(3);
	});

	it("reads the question above trailing option lines, not the last line of the reply", async () => {
		// The shape a real question to the user almost always has. The strict last
		// line is an option, so a detector that only looked there read the reply as
		// "the agent is done talking" and every route continued over it.
		const withOptions = [QUESTION_REPLY, "- SQLite: file-local, no server", "- Postgres: needs a server"].join("\n");
		expect(await armEverything([withOptions])).toBe(2);
	});
});

describe("an empty turn is not a question, and its retry terminates", () => {
	it("retries a text-free stop and then gives up instead of looping", async () => {
		// The empty-stop retry is the one settle continuation deliberately outside
		// the policy: a turn with no tool call and no text has no sentence that
		// could be a question, and its continuation is history repair rather than a
		// nudge. What it MUST have instead is a bound, so the assertion is that the
		// session settles at all and reports the failure. A cap raised into an
		// unbounded loop fails this by timeout, not by an off-by-one.
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: turn => {
				turn.finish();
			},
		});

		await sim.session.prompt("do the thing");

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.providerCalls()).toBeGreaterThan(1);
		expect(sim.providerCalls()).toBeLessThan(10);
		const ended = sim.eventsOfType("auto_retry_end");
		expect(ended.length).toBe(1);
		expect(ended[0]?.success).toBe(false);
		expect(ended[0]?.finalError).toContain("empty stop after retry cap");
	});

	it("takes the answer to a question over an empty retry once the model speaks", async () => {
		// A retried empty stop that comes back with a question must settle there:
		// the retry budget is spent on getting a turn worth reading, not on talking
		// past the reply it finally produced.
		sim = await createSimulation({
			settings: { "retry.enabled": false },
			script: scriptTurns(
				turn => {
					turn.finish();
				},
				turn => {
					turn.text(QUESTION_REPLY);
					turn.finish();
				},
			),
		});

		await sim.session.prompt("do the thing");

		expect(sim.session.isStreaming).toBe(false);
		expect(sim.providerCalls()).toBe(2);
		expect(sim.eventsOfType("auto_retry_end").length).toBe(0);
	});
});
