/**
 * The service tier a session is ON, as it changes at runtime and as a resumed
 * process reads it back.
 *
 * Two owners decide the live per-family map. The operator's `tier.*` settings
 * seed it at launch, and `/fast` overrides one family at runtime by setting
 * `priority` for the family of the current model. Every change is appended to
 * the transcript as a `service_tier_change` entry, and a session that resumes a
 * transcript holding one restores THAT rather than re-reading the settings: the
 * choice made inside the session outlives the process, which is the whole point
 * of persisting it.
 *
 * WHAT THIS CLOSES. Turning fast mode off cleared the family's tier outright, so
 * an operator configured for `flex` (cheaper and slower) who pressed `/fast`
 * twice was left on no tier at all: standard rates for the rest of the session,
 * no message saying so, and the loss persisted into every resume of that
 * transcript. `/fast off` now returns the family to its configured baseline,
 * and only a configured `priority` clears, because there is nothing else to go
 * back to.
 *
 * MEASURED RED PROOFS (each mutation applied alone, then reverted):
 *   - `setFastMode(false)` clearing the family instead of restoring the baseline:
 *     only the fast-off row reds, on both halves (the request after `/fast off`
 *     and the resumed session's request).
 *   - the resume path always taking the configured map: the two rows whose
 *     resumed session depends on a runtime choice red (the `/fast` row and the
 *     compaction-summary row), and the configured rows stay green.
 *   - the harness dropping the per-family map: the two configured rows red,
 *     which is the fidelity control for these scenarios.
 *
 * The tier is read with `sim.sessionRequests()` for the reason
 * `service-tier-on-side-requests.test.ts` documents: `mapOptionsForApi` projects
 * the request onto one api's option shape before the provider module runs, and
 * the simulated api has no service-tier field.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createSimulation, type Simulation, simTool } from "./harness";

const BULK = `worked. ${"tool output line. ".repeat(900)}`;
const SUMMARY_TEXT = "SUMMARY-OF-THE-WORK";

/** Every live simulation in this file, disposed newest first. */
const live: Simulation[] = [];

afterEach(async () => {
	for (const simulation of live.reverse()) await simulation.dispose();
	live.length = 0;
});

/** Tiers in call order, `absent` where the request carried none. */
function tiers(simulation: Simulation): string[] {
	return simulation.sessionRequests().map(request => request.serviceTier ?? "absent");
}

/**
 * A persisted session on an openai-family model (the family is the provider's,
 * whatever the simulated api is), answering each prompt with one text turn.
 */
async function session(settings: Record<string, unknown>): Promise<Simulation> {
	const simulation = await createSimulation({
		persist: true,
		settings,
		model: { provider: "openai", contextWindow: 200_000 },
		script: turn => {
			turn.usage({ input: 40, output: 4 });
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});
	live.push(simulation);
	return simulation;
}

async function resume(simulation: Simulation): Promise<Simulation> {
	const reopened = await simulation.reopen(simulation.sessionFile());
	live.push(reopened);
	return reopened;
}

describe("the tier a session is on, at runtime and after a resume", () => {
	it("carries a runtime /fast choice on the next request and into the resumed session", async () => {
		const sim = await session({ "tier.openai": "none" });
		await sim.session.prompt("one");

		expect(sim.session.setFastMode(true)).toBe(true);
		await sim.session.prompt("two");
		const reopened = await resume(sim);
		await reopened.session.prompt("three");

		// Nothing before the toggle, priority after it, and the resumed process reads
		// the choice off the transcript rather than the setting that says none.
		expect(tiers(sim)).toEqual(["absent", "priority"]);
		expect(tiers(reopened)).toEqual(["priority"]);
		expect(reopened.session.serviceTierByFamily).toEqual({ openai: "priority" });
		expect(reopened.session.isFastModeEnabled()).toBe(true);
	});

	it("takes the configured tier on a resume when the session never chose one", async () => {
		const sim = await session({ "tier.openai": "flex" });
		await sim.session.prompt("one");

		const reopened = await resume(sim);
		await reopened.session.prompt("two");

		expect(tiers(sim)).toEqual(["flex"]);
		expect(tiers(reopened)).toEqual(["flex"]);
		expect(reopened.session.isFastModeEnabled()).toBe(false);
	});

	it("returns to the configured tier when fast mode is turned off, in this session and the next", async () => {
		const sim = await session({ "tier.openai": "flex" });
		await sim.session.prompt("one");

		sim.session.setFastMode(true);
		sim.session.setFastMode(false);
		await sim.session.prompt("two");
		const reopened = await resume(sim);
		await reopened.session.prompt("three");

		// `flex` is a cheaper, slower tier the operator configured. Fast mode
		// overrode it and gave it back; it did not spend it.
		expect(tiers(sim)).toEqual(["flex", "flex"]);
		expect(tiers(reopened)).toEqual(["flex"]);
		expect(reopened.session.serviceTierByFamily).toEqual({ openai: "flex" });
		expect(reopened.session.isFastModeEnabled()).toBe(false);
	});

	it("puts a runtime choice on the compaction summary of the session that resumes it", async () => {
		const sim = await createSimulation({
			persist: true,
			settings: {
				"tier.openai": "none",
				"compaction.enabled": true,
				"compaction.threshold": "85%",
				"compaction.keepRecentTokens": 2_000,
				"compaction.remote": false,
			},
			model: { provider: "openai", contextWindow: 16_000 },
			tools: [simTool("work", async () => ({ content: [{ type: "text", text: BULK }] }))],
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
		live.push(sim);
		await sim.session.prompt("ask 0");
		sim.session.setFastMode(true);

		const reopened = await resume(sim);
		for (let index = 0; index < 4; index += 1) await reopened.session.prompt(`ask ${index}`);

		// Request 6 is the summarization request, and it is the point of this row:
		// the tier reaches a side request made by a session that read the choice off
		// a transcript rather than making it.
		const served = reopened
			.sessionRequests()
			.map(
				request => `${request.call}:${request.tools === 0 ? "summary" : "live"}:${request.serviceTier ?? "absent"}`,
			);
		expect(served.filter(entry => entry.includes(":summary:"))).toEqual(["6:summary:priority"]);
		expect(served.filter(entry => !entry.endsWith(":priority"))).toEqual([]);
	});
});
