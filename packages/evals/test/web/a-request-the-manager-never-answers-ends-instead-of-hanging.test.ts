/**
 * WHY: every HTTP request this package sent was unbounded.
 *
 * A manager wedged on a locked SQLite file, or a laptop that slept through a run, left the page
 * waiting on a promise that never settled: no rows, no error, a spinner that stayed. The poll behind
 * it never fired again either, because a poll cycle waits for the request it started, so one hung
 * request stopped the page updating for the rest of the session. The trace report and the vmnet
 * forward that carries an agent's auth request out of a container had the same shape.
 *
 * THE CLASS THIS CLOSES: a request with no end and a failure with no words. `fetchWithin` in
 * `src/core/bounded-fetch.ts` is the one bounded request; the dashboard's token request, both
 * `authedFetch` branches and `getJson` go through it, and the sweep here observes the bound on the
 * signal each of those routes hands to `fetch`, so a route added later is covered. A request that is
 * never answered, one the caller cancels itself, a normal answer and the named peer are all driven.
 *
 * WHAT IT DOES NOT CATCH: the SSE stream, which is long-lived by design and must not be bounded —
 * its heartbeat and unread-frame drop bound it. The trace report's and the vmnet forward's own call
 * sites are not driven here either: one is a CLI entrypoint and the other lives inside a
 * `Bun.serve` handler, so what is proven for them is the runner they call, not the wiring.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { setTimeout as sleepFor } from "node:timers/promises";
import { fetchWithin, REQUEST_TIMEOUT_MS } from "../../src/core/bounded-fetch";
import { authedFetch, forgetAuthToken, getJson } from "../../src/web/api";

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

		const hanging = fetchWithin("http://127.0.0.1:7391/api/runs", undefined, { timeoutMs: BOUND_MS });

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

	it("names the peer that went quiet, which is not always the manager", async () => {
		neverAnswers();

		const outcome = await Promise.race([
			fetchWithin("http://192.168.64.1:8787/token", undefined, {
				timeoutMs: BOUND_MS,
				subject: "the auth gateway",
			}).then(
				() => "answered",
				(err: unknown) => (err instanceof Error ? err.message : String(err)),
			),
			sleepFor(OBSERVATION_MS).then(() => "still waiting"),
		]);

		expect(outcome).toBe(`the auth gateway did not answer http://192.168.64.1:8787/token within ${BOUND_MS}ms`);
	});

	it("keeps the caller's own cancellation distinct from the bound", async () => {
		neverAnswers();
		const controller = new AbortController();

		// A bound far longer than this test could wait: only the caller's abort can end this.
		const cancelling = fetchWithin(
			"http://127.0.0.1:7391/api/runs",
			{ signal: controller.signal },
			{ timeoutMs: 60_000 },
		);
		controller.abort(new Error("the operator navigated away"));

		await expect(cancelling).rejects.toThrow(/the operator navigated away/);
	});

	it("returns the answer untouched when the manager answers", async () => {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ runs: [] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})) as unknown as typeof globalThis.fetch;

		const res = await fetchWithin("http://127.0.0.1:7391/api/runs", undefined, { timeoutMs: BOUND_MS });

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
