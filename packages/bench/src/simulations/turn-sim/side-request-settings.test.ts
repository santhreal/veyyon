/**
 * The requests the session makes for ITSELF, and whether the operator's provider
 * settings reach them.
 *
 * WHY THIS FILE EXISTS. A turn is not the only thing that talks to a provider. The
 * session also sends SIDE requests: the compaction summary above all, plus a
 * handoff and a tree-navigation summary. Those are unattended by definition, which
 * makes the settings that bound a request matter more there than on a turn the
 * operator is watching: the stream idle and first-event watchdogs are what END a
 * request whose provider goes silent, and the in-flight cap is what stops several
 * of them from going out at once.
 *
 * Production wires one transport for both (`sdk.ts` passes the same settings-aware,
 * concurrency-limited stream fn as `sideStreamFn`), but reaching it requires the
 * call site to hand `compact()` a `completeImpl`; the default inside `compact()` is
 * a bare `completeSimple` that reads no settings at all. Two of the five side sites
 * did not hand it over, and the most-fired one in the product was among them, so
 * every auto-compaction summary went out with NO watchdog, NO in-flight cap and no
 * routing variant, while the turn beside it carried all three. Nothing could see
 * it: the summary still arrived, and a silent summarizer is a hang rather than a
 * wrong answer.
 *
 * WHAT IS ASSERTED. The options the provider was actually called with, for a live
 * request and for the summarization request in the same session, under three
 * settings shapes: an ordinary pair of budgets, a zero (which means "no deadline"
 * and must survive as zero rather than collapsing into absent), and a negative
 * (which must be dropped rather than sent as a nonsense deadline). Each row checks
 * BOTH request kinds, because the conversion has one owner and a fix that reached
 * only the turn is the defect this file was written for.
 *
 * NOT asserted: the advisor's own compaction, which needs an advisor runtime this
 * harness does not build, and the fields `streamSimple` consumes before the
 * provider module is reached (the loop guard, `hideThinkingSummary`,
 * `openrouterVariant`). Their absence at this seam is not evidence either way, so
 * asserting it would be a green-by-luck test.
 *
 * RED PROOFS, measured. Removing `completeImpl` from the auto-compaction options
 * reds the budget row and the zero row on their summarizer half and leaves every
 * live-request assertion green, which is exactly the shape of the defect: the same
 * settings, applied to one of the two requests. The negative row stays green under
 * that mutant on purpose and says so here: a bare transport sends no budget
 * either, so `undefined` cannot tell the two apart. That row is about the
 * conversion, which its live half proves.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { bulkTool, createSimulation, type Simulation } from "./harness";

/** A window small enough that five prompts of tool output cross the trigger. */
const CONTEXT_WINDOW = 16_000;
const COMPACTING = {
	"compaction.enabled": true,
	"compaction.threshold": "85%",
	"compaction.keepRecentTokens": 2_000,
	"compaction.remote": false,
} as const;

/** The watchdog budgets one request was made with, as the provider saw them. */
interface Budgets {
	readonly summarizer: boolean;
	readonly idle: number | undefined;
	readonly first: number | undefined;
	readonly inFlight: Record<string, number> | undefined;
}

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

/** Grow a session until it compacts, and report every request's budgets. */
async function requestsUnder(settings: Record<string, unknown>): Promise<Budgets[]> {
	const requests: Budgets[] = [];
	sim = await createSimulation({
		model: { contextWindow: CONTEXT_WINDOW },
		settings: { ...COMPACTING, ...settings },
		tools: [bulkTool()],
		script: turn => {
			const tools = turn.context.tools?.length ?? 0;
			requests.push({
				summarizer: tools === 0,
				idle: turn.options?.streamIdleTimeoutMs,
				first: turn.options?.streamFirstEventTimeoutMs,
				inFlight: turn.options?.maxInFlightRequests,
			});
			if (tools === 0) {
				turn.text("SUMMARY-OF-THE-WORK");
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
	return requests;
}

/** The one summarization request, which every row needs to exist to mean anything. */
function summarizer(requests: Budgets[]): Budgets {
	const found = requests.filter(request => request.summarizer);
	expect(found.length).toBe(1);
	return found[0]!;
}

function live(requests: Budgets[]): Budgets[] {
	const found = requests.filter(request => !request.summarizer);
	expect(found.length).toBeGreaterThan(1);
	return found;
}

describe("a summarization request is bounded by the same settings as the turn beside it", () => {
	it("carries the operator's watchdog budgets and in-flight cap", async () => {
		const requests = await requestsUnder({
			"providers.streamIdleTimeoutSeconds": 0.5,
			"providers.streamFirstEventTimeoutSeconds": 0.4,
			"providers.maxInFlightRequests": { "amazon-bedrock": 2 },
		});

		const expected = { idle: 500, first: 400, inFlight: { "amazon-bedrock": 2 } };
		expect(summarizer(requests)).toMatchObject(expected);
		for (const request of live(requests)) expect(request).toMatchObject(expected);
	});

	it("sends a zero budget as zero, on both kinds of request", async () => {
		// Zero is the operator turning a watchdog OFF. Collapsing it into `undefined`
		// would silently restore the product default, which is the opposite request.
		const requests = await requestsUnder({
			"providers.streamIdleTimeoutSeconds": 0,
			"providers.streamFirstEventTimeoutSeconds": 0,
		});

		expect(summarizer(requests)).toMatchObject({ idle: 0, first: 0 });
		for (const request of live(requests)) expect(request).toMatchObject({ idle: 0, first: 0 });
	});

	it("drops a negative budget instead of sending a nonsense deadline", async () => {
		const requests = await requestsUnder({
			"providers.streamIdleTimeoutSeconds": -1,
			"providers.streamFirstEventTimeoutSeconds": -1,
		});

		expect(summarizer(requests)).toMatchObject({ idle: undefined, first: undefined });
		for (const request of live(requests)) expect(request).toMatchObject({ idle: undefined, first: undefined });
	});
});
