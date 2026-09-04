/**
 * WHY: every mutating dashboard action went through `authedFetch` and then decided for itself what
 * the answer meant. The token fetch swallowed its own failure and returned an empty string, so the
 * request went out unauthenticated and came back 401: a launch reported that as its own failure, and
 * the cancel button dropped the response entirely — the row kept running with nothing said, which
 * looks exactly like a cancel that worked. A cached token was never dropped either, so once the
 * manager restarted and minted a new one, every action failed with 401 until the page was reloaded.
 *
 * The class this closes: an action whose outcome the operator cannot see. `mutate` is the one place
 * that decides, and every state one mutating request can end in is swept here — an unreachable
 * manager, a refused or unreadable token, a rejected body, a non-JSON error page, an unreadable
 * success body, and a stale token. The retry is bounded and asserted by request count, so a
 * rejection loop shows up as a failing count rather than as a hung click.
 *
 * WHAT THIS DOES NOT CATCH: what a component renders for an outcome — the components pass the stated
 * reason to `alert` or their status line, and `mutate` never throws at a click handler. GET requests
 * carry no token and are covered by the polling and SSE suites.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { forgetAuthToken, type MutationOutcome, mutate } from "../../dashboard/api";
import type { CancelRunResponse } from "../../engine/store-shapes";

interface Call {
	readonly url: string;
	readonly method: string;
	readonly token: string | null;
}

const calls: Call[] = [];
let originalFetch: typeof globalThis.fetch;

/** Serve the token route from `token`, and every other request from `answer`. */
function serve(
	token: () => Response | Promise<Response>,
	answer: (attempt: number) => Response | Promise<Response>,
): void {
	let attempts = 0;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const headers = new Headers(init?.headers);
		calls.push({ url, method: init?.method ?? "GET", token: headers.get("x-evals-token") });
		if (url.includes("/api/token")) return token();
		attempts++;
		return answer(attempts);
	}) as unknown as typeof globalThis.fetch;
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (body: string, status = 200): Response => new Response(body, { status });
const issued = (value: string) => () => json({ token: value });

const post = (): Promise<MutationOutcome<CancelRunResponse>> =>
	mutate<CancelRunResponse>("POST", "/api/runs/:name/cancel", { name: "job-a" });

beforeEach(() => {
	originalFetch = globalThis.fetch;
	calls.length = 0;
	forgetAuthToken();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	forgetAuthToken();
});

describe("a dashboard action states what the manager did", () => {
	it("states the manager's own reason when it rejects the request", async () => {
		serve(issued("t1"), () => json({ error: "run job-a is already finished" }, 409));

		expect(await post()).toEqual({ data: null, error: "run job-a is already finished" });
	});

	it("states the status when the rejection carries no readable body", async () => {
		serve(issued("t1"), () => text("<html>bad gateway</html>", 502));

		const out = await post();
		expect(out.data).toBeNull();
		expect(out.error).toBe("/api/runs/:name/cancel: the manager answered 502");
	});

	it("states that a successful answer could not be read rather than reporting success", async () => {
		serve(issued("t1"), () => text("", 200));

		const out = await post();
		expect(out.data).toBeNull();
		expect(out.error).toBe("/api/runs/:name/cancel: the manager's answer could not be read");
	});

	it("returns the parsed body and carries the issued token on the request", async () => {
		serve(issued("t1"), () => json({ jobName: "job-a", cancelled: true }));

		expect(await post()).toEqual({ data: { jobName: "job-a", cancelled: true }, error: null });
		expect(calls.map(c => [c.method, c.token])).toEqual([
			["GET", null],
			["POST", "t1"],
		]);
	});

	it("sends no mutating request when the manager cannot be reached for a token", async () => {
		serve(
			() => {
				throw new Error("connection refused");
			},
			() => json({}),
		);

		const out = await post();
		expect(out.error).toBe("the manager did not answer a request for a session token: connection refused");
		expect(calls.map(c => c.method)).toEqual(["GET"]);
	});

	it("states a refused token, an unreadable one and an empty one, and sends nothing", async () => {
		const cases: [string, () => Response, string][] = [
			["refused", () => json({ error: "no" }, 500), "the manager refused to issue a session token (500)"],
			["unreadable", () => text("not json"), "the manager's session token could not be read:"],
			["empty", () => json({ token: "" }), "the manager issued an empty session token"],
		];
		for (const [, token, expected] of cases) {
			calls.length = 0;
			forgetAuthToken();
			serve(token, () => json({}));

			const out = await post();
			expect(out.error).toContain(expected);
			expect(calls.map(c => c.method)).toEqual(["GET"]);
		}
	});

	it("issues one token for repeated actions, then re-issues once after a rejection", async () => {
		let minted = 0;
		serve(
			() => {
				minted++;
				return json({ token: `t${minted}` });
			},
			attempt => (attempt === 3 ? json({ error: "stale" }, 401) : json({ jobName: "job-a", cancelled: true })),
		);

		expect((await post()).error).toBeNull();
		expect((await post()).error).toBeNull();
		expect(minted).toBe(1); // the token is cached across actions

		expect((await post()).error).toBeNull();
		expect(minted).toBe(2); // the 401 dropped it and the retry carried a fresh one
		expect(calls.filter(c => c.method === "POST").map(c => c.token)).toEqual(["t1", "t1", "t1", "t2"]);
	});

	it("retries a rejected token exactly once and then states the rejection", async () => {
		// The third attempt answers something else, so an unbounded retry ends with the wrong reason
		// and a wrong count rather than looping until the test process is killed.
		serve(issued("t1"), attempt =>
			attempt <= 2
				? json({ error: "unauthorized: valid token required for mutating requests" }, 401)
				: json({ error: "the manager gave up" }, 500),
		);

		const out = await post();
		expect(out.error).toBe("unauthorized: valid token required for mutating requests");
		expect(calls.filter(c => c.method === "POST")).toHaveLength(2);
	});
});
