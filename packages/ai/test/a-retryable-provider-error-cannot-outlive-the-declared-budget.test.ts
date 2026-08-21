/**
 * A retryable provider error that IS a stall cannot outlive the caller's budget.
 *
 * WHY THIS SUITE EXISTS. `no-api-outlives-the-budget-its-caller-declared.test.ts`
 * drives an endpoint that says nothing at all, which reaches the pre-response
 * fence and the stream watchdog. It never reaches the OTHER retry ladder: the
 * one that runs when the server DOES answer, with an error envelope marked
 * retryable. Codex reopens the stream for those, up to `CODEX_MAX_RETRIES`, with
 * growing backoff, and each reopen waits for a first event again — so an
 * envelope that says "upstream timed out" multiplied the caller's declared
 * first-event budget by six and added ~7s of backoff on top. The mutation that
 * proved the gap: deleting the budget veto in `#tryRetryProviderError` left the
 * silence sweep entirely green.
 *
 * THE CLASS IT CLOSES. "A retry ladder driven by a server-sent error keeps
 * spending the caller's pre-first-event budget after that budget is gone." The
 * distinction the guard must preserve is the point of the class: a FAST
 * retryable error is still retried (the server answered quickly, the budget is
 * intact, and a reopen is the right move), and only an error that both looks
 * like a stall and arrives after the budget is spent ends the turn.
 *
 * WHAT IT DOES NOT CATCH. It pins the attempt count and the wall-clock bound for
 * one provider's envelope ladder, not the wording of the surfaced error, and not
 * the equivalent ladder in a provider that grows one later — the sibling sweep's
 * membership pin is what makes a new API visible, and a new *ladder* inside an
 * existing provider is only covered here if it runs on this path.
 */
import { describe, expect, it } from "bun:test";
import { stream } from "@veyyon/ai/stream";
import type { Context } from "@veyyon/ai/types";
import { createCodexModel } from "./helpers";
import type { CountingFetch } from "./helpers/silent-transport";

/** The caller's declared pre-first-event budget for every case below. */
const DECLARED_BUDGET_MS = 400;

const context: Context = { messages: [{ role: "user", content: "probe", timestamp: 1 }] };

/**
 * A retryable Codex failure envelope whose text also reads as a stall:
 * `server_error` is in `CODEX_RETRYABLE_EVENT_CODES`, and "timed out" is what
 * `isPreResponseStall` matches. A gateway that gave up on its upstream sends
 * exactly this shape.
 */
const RETRYABLE_STALL_EVENT = `event: error\ndata: ${JSON.stringify({
	type: "error",
	error: { code: "server_error", message: "Upstream request timed out" },
})}\n\n`;

/**
 * A fetch that answers `200` with that one envelope after `delayMs`, counting
 * attempts. A real timer and a real body, because the subject is how long a
 * ladder runs and a fake clock cannot drive a reopen.
 */
function fetchThatFailsRetryablyAfter(delayMs: number): CountingFetch {
	const impl: CountingFetch = async (_input, init) => {
		impl.calls += 1;
		if (delayMs > 0) {
			const waited = Promise.withResolvers<void>();
			const timer = setTimeout(() => waited.resolve(), delayMs);
			init?.signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				waited.resolve();
			});
			await waited.promise;
		}
		return new Response(RETRYABLE_STALL_EVENT, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	};
	impl.calls = 0;
	return impl;
}

interface TurnOutcome {
	attempts: number;
	elapsedMs: number;
	failed: boolean;
}

async function runTurn(transport: CountingFetch, budgetMs: number): Promise<TurnOutcome> {
	const started = Date.now();
	const events = stream(createCodexModel("gpt-5.1-codex"), context, {
		apiKey: "probe-key",
		fetch: transport,
		streamFirstEventTimeoutMs: budgetMs,
		streamIdleTimeoutMs: budgetMs,
	});
	let failed = false;
	try {
		for await (const event of events) failed = failed || event.type === "error";
		const message = await events.result();
		failed = failed || message.stopReason === "error" || message.stopReason === "aborted";
	} catch {
		failed = true;
	}
	return { attempts: transport.calls, elapsedMs: Date.now() - started, failed };
}

describe("a retryable provider error cannot outlive the declared budget", () => {
	it("stops reopening once the declared first-event budget is spent", async () => {
		// Each attempt burns roughly two thirds of the budget, so the budget is
		// gone partway through the second one and the ladder must stop there. The
		// unguarded ladder runs six attempts plus 7.5s of backoff.
		const transport = fetchThatFailsRetryablyAfter(Math.round(DECLARED_BUDGET_MS * 0.7));
		const outcome = await runTurn(transport, DECLARED_BUDGET_MS);
		expect(outcome.failed).toBe(true);
		expect(outcome.attempts).toBe(2);
		expect(outcome.elapsedMs).toBeLessThan(DECLARED_BUDGET_MS * 6);
	}, 30_000);

	it("still exhausts the ladder when the budget is generous", async () => {
		// The other direction, and the reason the guard is a predicate rather than
		// a fence around the whole ladder: a caller that declared room for the
		// ladder still gets it. Six attempts is `CODEX_MAX_RETRIES + 1`, and the
		// whole ladder — backoff included — fits inside the declared budget, which
		// is what "the budget bounds the phase" means.
		const generousBudgetMs = 20_000;
		const transport = fetchThatFailsRetryablyAfter(0);
		const outcome = await runTurn(transport, generousBudgetMs);
		expect(outcome.failed).toBe(true);
		expect(outcome.attempts).toBe(6);
		expect(outcome.elapsedMs).toBeLessThan(generousBudgetMs);
	}, 60_000);
});
