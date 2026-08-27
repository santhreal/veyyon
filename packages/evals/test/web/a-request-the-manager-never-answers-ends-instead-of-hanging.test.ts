/**
 * WHY: every dashboard request was unbounded.
 *
 * A manager wedged on a locked SQLite file, or a laptop that slept through a run, left the page
 * waiting on a promise that never settled: no rows, no error, a spinner that stayed. The poll behind
 * it never fired again either, because a poll cycle waits for the request it started, so one hung
 * request stopped the page updating for the rest of the session.
 *
 * THE CLASS THIS CLOSES: a request with no end and a failure with no words. `fetchWithin` in
 * `src/web/api.ts` is the single fetch every request in that module goes through — the token request,
 * both `authedFetch` branches and `getJson` — so a route added later is bounded by construction. The
 * cases drive a request that is never answered, one the caller cancels itself, and a normal answer,
 * and assert the bound produces a message naming the manager rather than a bare `AbortError`.
 *
 * WHAT IT DOES NOT CATCH: the SSE stream, which is a long-lived connection and must not be bounded —
 * its own heartbeat and unread-frame drop bound it. It also does not prove a component renders the
 * message; `test/web/a-progress-bar-draws-every-decided-trial.test.tsx` and the poll suite own that.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setTimeout as sleepFor } from "node:timers/promises";
import { authedFetch, fetchWithin, forgetAuthToken, getJson, REQUEST_TIMEOUT_MS } from "../../src/web/api";

/** Short enough to keep the suite fast; that the request ends at all is the behaviour under test. */
const BOUND_MS = 30;
/** Long enough that a bound of 30ms always wins, short enough that an unbounded one loses. */
const OBSERVATION_MS = 2000;

let originalFetch: typeof globalThis.fetch;

/** A manager that accepted the connection and answered nothing: only an abort ends this. */
function neverAnswers(): void {
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		const { promise, reject } = Promise.withResolvers<Response>();
		init?.signal?.addEventListener("abort", () => reject(init.signal?.reason ?? new Error("aborted")), {
			once: true,
		});
		return promise;
	}) as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("a request the manager never answers", () => {
	it("ends at the bound and names what did not answer", async () => {
		neverAnswers();

		const hanging = fetchWithin("http://127.0.0.1:7391/api/runs", undefined, BOUND_MS);

		// Raced against real time on purpose: a request with no bound never settles, and a case that
		// only awaits it would hang the file rather than fail it. The outcome is asserted, never a
		// duration.
		const outcome = await Promise.race([
			hanging.then(
				() => "the manager answered",
				(err: unknown) => (err instanceof Error ? err.message : String(err)),
			),
			sleepFor(OBSERVATION_MS).then(() => "still waiting"),
		]);

		expect(outcome).toBe(`the manager did not answer http://127.0.0.1:7391/api/runs within ${BOUND_MS}ms`);
	});

	it("keeps the caller's own cancellation distinct from the bound", async () => {
		neverAnswers();
		const controller = new AbortController();

		// A bound far longer than this test could wait: only the caller's abort can end this.
		const cancelling = fetchWithin("http://127.0.0.1:7391/api/runs", { signal: controller.signal }, 60_000);
		controller.abort(new Error("the operator navigated away"));

		await expect(cancelling).rejects.toThrow(/the operator navigated away/);
	});

	it("returns the answer untouched when the manager answers", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ runs: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof globalThis.fetch;

		const res = await fetchWithin("http://127.0.0.1:7391/api/runs", undefined, BOUND_MS);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ runs: [] });
	});

	it("carries the bound on every route the module offers, not only the one under test", async () => {
		const bounded: { url: string; bound: boolean }[] = [];
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			// A signal that is not yet aborted is a live bound; the pre-fix path passed none at all.
			bounded.push({ url, bound: init?.signal instanceof AbortSignal && !init.signal.aborted });
			return new Response(JSON.stringify(url.includes("/api/token") ? { token: "t" } : {}), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}) as unknown as typeof globalThis.fetch;
		forgetAuthToken();

		await getJson("/api/runs");
		await authedFetch("GET", "/api/runs");
		await authedFetch("POST", "/api/runs/:name/cancel", { name: "r1" });

		expect(bounded.map(call => call.bound)).toEqual([true, true, true, true]);
		expect(bounded.filter(call => call.url.includes("/api/token"))).toHaveLength(1);
	});

	it("waits fifteen seconds for the manager", () => {
		// Pinned as a literal: every case above passes its own bound, so a default that drifted to
		// minutes would leave this file green while the page sat on one request.
		expect(REQUEST_TIMEOUT_MS).toBe(15_000);
	});
});
