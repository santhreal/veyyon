/**
 * What a retry fallback chain costs, and what brings the primary back.
 *
 * WHY THIS FILE EXISTS. `retry.fallbackChains` moves a failing turn onto another
 * model, and `retry.fallbackRevertPolicy` decides whether the session ever goes
 * back. Three different things can hold a session on the fallback, and only one
 * of them is the policy: the primary's cooldown suppression is still live, the
 * session is inside a retry sequence that has not settled, or the operator asked
 * to stay put. A test that only watches one turn cannot tell them apart, and the
 * failure modes point in opposite directions. Coming back too early means the
 * pair hands the turn to each other for as long as the fault lasts, re-sending
 * the whole prompt at full input rate each lap. Never coming back means a
 * one-off 500 silently retires the operator's chosen model for the session.
 *
 * WHAT IS ASSERTED. Which model actually served each request, across turn
 * boundaries as well as inside one turn; the `retry_fallback_applied` event and
 * the `model_change` entries both directions; and for each of the three holds,
 * the state that proves WHICH hold it was. The `cooldown-expiry` rows run twice
 * with the same policy and different suppression state, so a build that returned
 * to the primary on any turn boundary rather than on the cooldown reds one of
 * them. The `never` row asserts the primary is NOT suppressed while the session
 * stays away from it, so the row can only pass because of the policy.
 *
 * Both models are real bedrock catalog entries: the chain is resolved through
 * the registry, so a scenario cannot invent a candidate the product would skip.
 * A 1ms cooldown comes from a `retry-after-ms` hint the production parser reads
 * out of the provider's own error text, so the expiry is causal and nothing here
 * sleeps or reads a clock.
 *
 * NOT asserted: cross-provider chains and `provider/*` wildcard entries. The
 * simulation holds one credential and one API by construction, so a second
 * provider would only rename the seam. Also not asserted: the thinking level a
 * chain entry can carry, which belongs to the selector parser.
 *
 * RED PROOFS, measured. (a) Returning `"cooldown-expiry"` from
 * `#getRetryFallbackRevertPolicy` regardless of the setting reds the `never` row
 * only (turn 2 goes back to the primary while its cooldown reads expired), and
 * returning `"never"` unconditionally reds the cooldown-expiry row only.
 * (b) Dropping `if (this.#retryAttempt > 0) return;` from
 * `#maybeRestoreRetryFallbackPrimary` reds three of the five rows, because the
 * primary comes back inside the sequence that just left it: the retry of the
 * failing turn is served by the primary again instead of the fallback, and the
 * burning-sequence row stops terminating at all (it dies on the per-test budget
 * rather than on an assertion). That is the ping-pong the guard exists to stop.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createSimulation, type Simulation } from "./harness";

/** Two real bedrock catalog ids, so the chain resolves through the registry. */
const PRIMARY = "anthropic.claude-opus-4-7";
const FALLBACK = "anthropic.claude-sonnet-5";
const PRIMARY_SELECTOR = `amazon-bedrock/${PRIMARY}`;
const FALLBACK_SELECTOR = `amazon-bedrock/${FALLBACK}`;
const CHAIN = { [PRIMARY_SELECTOR]: [FALLBACK_SELECTOR] };

/**
 * A retryable provider failure. The `retry-after-ms` hint is what the production
 * parser reads to size the primary's cooldown, so the 1ms spelling is an expired
 * suppression by the time the next turn starts, and the bare spelling leaves the
 * cooldown live for the server-error backoff.
 */
const EXPIRED_COOLDOWN_ERROR = "500 Internal Server Error from bedrock (retry-after-ms: 1)";
const LIVE_COOLDOWN_ERROR = "500 Internal Server Error from bedrock";

let sim: Simulation | undefined;

afterEach(async () => {
	await sim?.dispose();
	sim = undefined;
});

interface FallbackRun {
	/** `call:modelId` for every request the simulation served, in order. */
	readonly served: string[];
	/** `from->to@role` for every applied fallback. */
	readonly applied: string[];
	/** `selector@role` for every model change the transcript recorded. */
	readonly changes: string[];
	readonly primarySuppressed: boolean;
	readonly modelNow: string | undefined;
}

/**
 * Fail the first request with `failWith`, answer every later one, and send
 * `prompts` in order. Everything a row reads is collected here so the rows
 * differ only in the policy, the error, and how many turns follow the failure.
 */
async function runFallback(options: {
	revertPolicy: "cooldown-expiry" | "never";
	failWith: string;
	prompts: readonly string[];
	failEveryRequest?: boolean;
}): Promise<FallbackRun> {
	const served: string[] = [];
	sim = await createSimulation({
		modelId: PRIMARY,
		settings: {
			"retry.fallbackChains": CHAIN,
			"retry.fallbackRevertPolicy": options.revertPolicy,
		},
		script: turn => {
			served.push(`${turn.call}:${turn.model.id}`);
			if (options.failEveryRequest || turn.call === 1) {
				turn.fail(options.failWith);
				return;
			}
			turn.text(`answer ${turn.call}`);
			turn.finish();
		},
	});
	for (const prompt of options.prompts) {
		await sim.session.prompt(prompt);
	}
	return {
		served,
		applied: sim.eventsOfType("retry_fallback_applied").map(event => `${event.from}->${event.to}@${event.role}`),
		changes: sim.sessionManager
			.getEntries()
			.filter(entry => entry.type === "model_change")
			.map(entry => {
				const change = entry as { model?: string; role?: string };
				return `${change.model ?? "none"}@${change.role ?? "none"}`;
			}),
		primarySuppressed: sim.modelRegistry.isSelectorSuppressed(PRIMARY_SELECTOR),
		modelNow: sim.session.model?.id,
	};
}

describe("a retry fallback chain moves the turn and the cooldown decides the way back", () => {
	it("finishes the failing turn on the next model in the chain", async () => {
		const run = await runFallback({
			revertPolicy: "cooldown-expiry",
			failWith: EXPIRED_COOLDOWN_ERROR,
			prompts: ["one"],
		});

		// The retry that follows the failure is served by the fallback, so the user
		// gets an answer out of a turn whose first request died.
		expect(run.served).toEqual([`1:${PRIMARY}`, `2:${FALLBACK}`]);
		// The role is the chain key that owned the failing model, which is what a
		// later failure resolves its next candidate against.
		expect(run.applied).toEqual([`${PRIMARY_SELECTOR}->${FALLBACK_SELECTOR}@${PRIMARY_SELECTOR}`]);
		// A fallback is not a settings write: the transcript records it as an
		// ephemeral change so a reload does not adopt it as the operator's model.
		expect(run.changes).toEqual([`${FALLBACK_SELECTOR}@fallback`]);
		expect(run.modelNow).toBe(FALLBACK);
	});

	it("returns to the primary on the next turn once the cooldown has expired", async () => {
		const run = await runFallback({
			revertPolicy: "cooldown-expiry",
			failWith: EXPIRED_COOLDOWN_ERROR,
			prompts: ["one", "two"],
		});

		expect(run.served).toEqual([`1:${PRIMARY}`, `2:${FALLBACK}`, `3:${PRIMARY}`]);
		expect(run.applied.length).toBe(1);
		expect(run.changes).toEqual([`${FALLBACK_SELECTOR}@fallback`, `${PRIMARY_SELECTOR}@fallback`]);
		expect(run.primarySuppressed).toBe(false);
		expect(run.modelNow).toBe(PRIMARY);
	});

	it("stays on the fallback under the same policy while the primary's cooldown is live", async () => {
		const run = await runFallback({
			revertPolicy: "cooldown-expiry",
			failWith: LIVE_COOLDOWN_ERROR,
			prompts: ["one", "two"],
		});

		// Same policy as the row above, and the opposite outcome: the turn boundary
		// is not what brings the primary back, the expiry is. The provider named no
		// retry-after here, so the primary carries the server-error backoff and the
		// next turn is still the fallback's.
		expect(run.served).toEqual([`1:${PRIMARY}`, `2:${FALLBACK}`, `3:${FALLBACK}`]);
		expect(run.primarySuppressed).toBe(true);
		expect(run.changes).toEqual([`${FALLBACK_SELECTOR}@fallback`]);
		expect(run.modelNow).toBe(FALLBACK);
	});

	it("keeps the fallback for the rest of the session when the operator says never", async () => {
		const run = await runFallback({
			revertPolicy: "never",
			failWith: EXPIRED_COOLDOWN_ERROR,
			prompts: ["one", "two", "three"],
		});

		expect(run.served).toEqual([`1:${PRIMARY}`, `2:${FALLBACK}`, `3:${FALLBACK}`, `4:${FALLBACK}`]);
		// Nothing is holding the primary back except the policy: its cooldown has
		// expired, so a build that ignored the setting would have returned to it on
		// the second turn.
		expect(run.primarySuppressed).toBe(false);
		expect(run.applied.length).toBe(1);
		expect(run.changes).toEqual([`${FALLBACK_SELECTOR}@fallback`]);
		expect(run.modelNow).toBe(FALLBACK);
	});

	it("never hands the turn back while one retry sequence is still burning", async () => {
		const run = await runFallback({
			revertPolicy: "cooldown-expiry",
			failWith: EXPIRED_COOLDOWN_ERROR,
			prompts: ["one"],
			failEveryRequest: true,
		});

		// The fallback fails too, and its own cooldown-expired primary is one
		// restore away. Inside the sequence the session stays where it is: the
		// primary is served once, at the start, and never again.
		expect(run.served).toEqual([`1:${PRIMARY}`, `2:${FALLBACK}`, `3:${FALLBACK}`]);
		expect(run.served.slice(1).some(entry => entry.endsWith(PRIMARY))).toBe(false);
		expect(run.applied.length).toBe(1);
		// The chain has no third model, so the turn ends failed rather than looping.
		const ends = sim?.eventsOfType("auto_retry_end") ?? [];
		expect(ends.map(end => `${end.success}/${end.attempt}`)).toEqual(["false/2"]);
		expect(run.modelNow).toBe(FALLBACK);
	});
});
