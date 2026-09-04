/**
 * The operator's service tier on the requests the session makes for itself.
 *
 * `tier.openai` / `tier.anthropic` / `tier.google` say how a family's requests
 * are queued and served, which is billing and latency, and they reach a session
 * as one per-family map (`buildServiceTierByFamily` in sdk.ts). The live turn
 * carries the resolved value because the loop asks the session for it on every
 * request (`Agent.serviceTierResolver` -> `#effectiveServiceTier`). A SIDE
 * request is one the session makes for itself rather than for the conversation:
 * the compaction summary, the turn-prefix summary of a split turn, a handoff, a
 * branch summary. Those are built by hand at their call sites, so each one
 * carries only what its site listed.
 *
 * WHAT THIS CLOSES. Compaction sends the largest payload of a session, and its
 * summarization request carried no tier at all: an operator on `flex` (cheaper,
 * slower) had their biggest request billed at standard rates, and an operator on
 * `priority` had the request that blocks the next turn served at standard speed.
 * The chain a tier now travels is four hops, and every one of them is
 * load-bearing:
 *
 *   1. the harness/sdk builds the per-family map from the three settings
 *   2. the session resolves the candidate's family (`#effectiveServiceTier`)
 *      and lists `serviceTier` in the compaction options
 *   3. `compact()` copies it into the `summaryOptions` it rebuilds field by field
 *   4. `generateSummary` / `generateTurnPrefixSummary` put it on the request
 *
 * MEASURED RED PROOFS (each mutation applied alone, then reverted):
 *   - session auto-compaction site loses `serviceTier`: row 1 becomes
 *     `8:summary:absent` and every live request stays `flex`.
 *   - `compact()`'s hand-written `summaryOptions` rebuild drops the field: same
 *     single red. This is the drop point the class lives at: a new option added
 *     to `SummaryOptions` and forwarded at the request reaches nothing unless it
 *     is also restated in that rebuild.
 *   - `generateSummary` stops sending it: same single red.
 *   - `generateTurnPrefixSummary` stops sending it: only request 8 of the manual
 *     row reds, which is what identifies 7 as the main summary and 8 as the
 *     turn prefix.
 *   - the session's manual compaction site loses it: BOTH manual summarizer
 *     requests red and the live requests stay green.
 *   - the harness stops building the map: every request in row 1 goes absent,
 *     live ones included. That is the fidelity control. Without the map a
 *     simulation reports absent everywhere, and absent everywhere looks like
 *     agreement, which is why the assertions below pin the live requests too.
 *
 * WHERE THE TIER IS OBSERVED, AND WHY NOT ON THE WIRE. `mapOptionsForApi`
 * projects the request onto one api's option shape before the provider module
 * runs, and `bedrock-converse-stream` has no service-tier field, so the scripted
 * transport never sees one and `ScriptedTurn.options` cannot answer this
 * question. `sim.sessionRequests()` records what the session and the loop handed
 * the transport, which is the seam the operator's knob has to reach; whether the
 * value is then written as `service_tier`, as Anthropic's `speed: "fast"`, or
 * dropped is `shouldSendServiceTier`'s decision inside the provider module and a
 * pi-ai concern.
 *
 * NOT ASSERTED HERE.
 *   - Server-side compaction (`compaction.remote` plus a model the OpenAI
 *     Responses compaction endpoint admits) carries no tier and cannot: that
 *     endpoint's request body is `{ model, input, instructions? }`. The omission
 *     is the endpoint's contract, not a dropped field.
 *   - The advisor overflow summary resolves the ADVISOR tier (`tier.advisor`,
 *     which may inherit the session's) through the advisor agent's own resolver,
 *     and the branch summary of a tree navigation resolves the session's. Both
 *     sites now pass it; neither is reachable from this shape.
 *   - `tier.subagent` applies to spawned subagents, which run out of process and
 *     are not simulated.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { bulkTool, createSimulation, type Simulation, type SimulationRequest } from "./harness";
import { describeViolations, turnViolations } from "./invariants";

const SUMMARY_TEXT = "SUMMARY-OF-THE-WORK";

/**
 * A percentage trigger and a local summarizer, so the summary is a request this
 * simulation serves rather than a provider-side window it cannot see.
 */
const LOCAL_SUMMARIZER = {
	"compaction.keepRecentTokens": 2_000,
	"compaction.remote": false,
} as const;

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** `call:kind:tier`, where a request with no tools is a side request. */
function served(requests: SimulationRequest[]): string[] {
	return requests.map(
		request => `${request.call}:${request.tools === 0 ? "summary" : "live"}:${request.serviceTier ?? "absent"}`,
	);
}

/**
 * A session that grows until it crosses the auto-compaction trigger. `provider`
 * decides the model's tier family: `openai` is the openai family whatever its
 * api, and `amazon-bedrock` on the simulated api resolves no family at all.
 */
async function autoCompact(settings: Record<string, unknown>, provider: string): Promise<Simulation> {
	sim = await createSimulation({
		settings: { ...LOCAL_SUMMARIZER, "compaction.enabled": true, "compaction.threshold": "85%", ...settings },
		model: { provider, contextWindow: 16_000 },
		tools: [bulkTool()],
		script: turn => {
			if ((turn.context.tools?.length ?? 0) === 0) {
				turn.text(SUMMARY_TEXT);
				turn.finish();
				return;
			}
			turn.usage({ input: 400, output: 40 });
			if (turn.call % 2 === 1) {
				turn.toolCall("work", {}, "call_0");
				turn.finish("toolUse");
				return;
			}
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});
	for (let index = 0; index < 5; index += 1) await sim.session.prompt(`ask ${index}`);
	return sim;
}

describe("the operator's service tier on a request the session makes for itself", () => {
	it("sends the configured tier on the auto-compaction summary, not only on the conversation", async () => {
		const run = await autoCompact({ "tier.openai": "flex" }, "openai");

		// Request 8 is the summarization request: the crossing is reached on the
		// eighth call and it is the only one asked without the conversation's tools.
		expect(served(run.sessionRequests())).toEqual([
			"1:live:flex",
			"2:live:flex",
			"3:live:flex",
			"4:live:flex",
			"5:live:flex",
			"6:live:flex",
			"7:live:flex",
			"8:summary:flex",
			"9:live:flex",
			"10:live:flex",
			"11:live:flex",
			"12:live:flex",
		]);
		expect(describeViolations("session", turnViolations(run))).toEqual([]);
	});

	it("sends no tier at all when the family's setting is none", async () => {
		const run = await autoCompact({ "tier.openai": "none" }, "openai");

		const requests = run.sessionRequests();
		// The positive control: compaction still ran, so the row below is a session
		// that reached the summarizer and asked for no tier, not one that never
		// compacted.
		expect(served(requests).filter(entry => entry.includes(":summary:"))).toEqual(["8:summary:absent"]);
		expect(requests.filter(request => request.serviceTier !== undefined)).toEqual([]);
	});

	it("ignores another family's tier, including on the summary", async () => {
		// The model is openai family; `priority` is configured for anthropic. A
		// blanket apply would put a tier the operator never chose for this family on
		// every request, and pay for it.
		const run = await autoCompact({ "tier.anthropic": "priority" }, "openai");

		expect(served(run.sessionRequests()).filter(entry => entry.includes(":summary:"))).toEqual(["8:summary:absent"]);
		expect(run.sessionRequests().filter(request => request.serviceTier !== undefined)).toEqual([]);
	});

	it("sends no tier for a model whose family has no service-tier control", async () => {
		// `amazon-bedrock` on the simulated api is neither the openai family (wrong
		// api and provider) nor the anthropic one (that needs `anthropic-messages`),
		// so both configured knobs resolve to nothing for it.
		const run = await autoCompact({ "tier.openai": "flex", "tier.anthropic": "priority" }, "amazon-bedrock");

		expect(served(run.sessionRequests()).filter(entry => entry.includes(":summary:"))).toEqual(["8:summary:absent"]);
		expect(run.sessionRequests().filter(request => request.serviceTier !== undefined)).toEqual([]);
	});

	it("sends the tier on both summaries a manual compaction of a split turn asks for", async () => {
		sim = await createSimulation({
			settings: { ...LOCAL_SUMMARIZER, "compaction.enabled": false, "tier.openai": "flex" },
			model: { provider: "openai", contextWindow: 16_000 },
			tools: [bulkTool()],
			script: turn => {
				if ((turn.context.tools?.length ?? 0) === 0) {
					turn.text(SUMMARY_TEXT);
					turn.finish();
					return;
				}
				turn.usage({ input: 400, output: 40 });
				if (turn.call % 2 === 1) {
					turn.toolCall("work", {}, "call_0");
					turn.finish("toolUse");
					return;
				}
				turn.text(`answer ${turn.call}`);
				turn.finish();
			},
		});
		for (let index = 0; index < 3; index += 1) await sim.session.prompt(`ask ${index}`);

		const result = await sim.session.compact();

		// The cut lands inside a turn, so the manual path asks for two summaries:
		// request 7 is the main one and request 8 the turn prefix. They are written
		// by two different functions and both have to carry the tier.
		expect(result.summary).toContain(SUMMARY_TEXT);
		expect(served(sim.sessionRequests())).toEqual([
			"1:live:flex",
			"2:live:flex",
			"3:live:flex",
			"4:live:flex",
			"5:live:flex",
			"6:live:flex",
			"7:summary:flex",
			"8:summary:flex",
		]);
	});
});
