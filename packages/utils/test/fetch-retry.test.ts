import { describe, expect, it } from "bun:test";
import { isAbortError } from "@veyyon/utils/abortable";
import * as fetchRetry from "@veyyon/utils/fetch-retry";
import {
	extractHttpStatusFromError,
	extractRetryHint,
	fetchWithRetry,
	isRetryableStatus,
	isUnexpectedSocketCloseMessage,
	RESET_EPOCH_MS_MIN,
	RESET_EPOCH_S_MIN,
	resetHeaderTargetMs,
} from "@veyyon/utils/fetch-retry";

describe("fetchWithRetry", () => {
	it("routes requests through the `fetch` override when provided", async () => {
		const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
		const customFetch = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ input, init });
			return new Response("ok", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/x", {
			method: "POST",
			body: "hi",
			fetch: customFetch,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("https://example.invalid/x");
		expect(calls[0]?.init).toMatchObject({ method: "POST", body: "hi" });
	});

	it("retries through the override on transient failures", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			if (attempt === 1) return new Response("", { status: 503 });
			return new Response("done", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/y", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("done");
		expect(attempt).toBe(2);
	});

	it("lets callers stop retries for deterministic response bodies", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return new Response("deterministic provider failure", { status: 500 });
		};

		const response = await fetchWithRetry("https://example.invalid/z", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			shouldRetryResponse: (_response, bodyText) => !bodyText.includes("deterministic"),
		});

		expect(response.status).toBe(500);
		expect(await response.text()).toBe("deterministic provider failure");
		expect(attempt).toBe(1);
	});

	/**
	 * WHY: the transient set was the GATE in front of the verdict, so a caller that knew its API
	 * documents 409 as retryable, or that reads a decision out of a 400's body, never got asked. The
	 * set is the default for a caller with no verdict; it is not a veto over one.
	 */
	it.each([409, 400, 401])("asks the caller's verdict about a %s", async status => {
		let attempts = 0;
		const customFetch = async () => {
			attempts += 1;
			return attempts === 1 ? new Response("try again", { status }) : new Response("ok", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/verdict", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			shouldRetryResponse: (_response, bodyText) => bodyText === "try again",
		});

		expect(response.status).toBe(200);
		expect(attempts).toBe(2);
	});

	it("never reads the body of a success, and never asks about one", async () => {
		// A 2xx may be a live stream: `clone().text()` on one buffers the whole response, so the loop
		// returns before it can. A verdict that would retry everything must not see it.
		let asked = 0;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("first chunk"));
			},
		});

		const response = await fetchWithRetry("https://example.invalid/stream", {
			fetch: async () => new Response(stream, { status: 200 }),
			defaultDelayMs: 1,
			maxAttempts: 3,
			shouldRetryResponse: () => {
				asked += 1;
				return true;
			},
		});

		expect(asked).toBe(0);
		expect(response.bodyUsed).toBe(false);
	});

	it("falls back to the transient set when no verdict is passed", async () => {
		let attempts = 0;
		const customFetch = async () => {
			attempts += 1;
			return new Response("gone", { status: 404 });
		};

		const response = await fetchWithRetry("https://example.invalid/default", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
		});

		expect(response.status).toBe(404);
		expect(attempts).toBe(1);
	});

	it("returns retryable responses immediately when retry hints exceed the delay cap", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return new Response("slow down", { status: 429, headers: { "Retry-After": "3600" } });
		};

		const response = await fetchWithRetry("https://example.invalid/rate-limit", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			maxDelayMs: 10,
		});

		expect(response.status).toBe(429);
		expect(await response.text()).toBe("slow down");
		expect(attempt).toBe(1);
	});

	it("rotates the URL per attempt when given a function", async () => {
		const urls: string[] = [];
		const customFetch = async (input: string | URL | Request) => {
			urls.push(String(input));
			return new Response("", { status: urls.length < 3 ? 503 : 200 });
		};
		const response = await fetchWithRetry(attempt => `https://example.invalid/mirror-${attempt}`, {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
		});
		expect(response.status).toBe(200);
		expect(urls).toEqual([
			"https://example.invalid/mirror-0",
			"https://example.invalid/mirror-1",
			"https://example.invalid/mirror-2",
		]);
	});

	it("shallow-merges prepareInit headers over the base headers each attempt", async () => {
		const seen: string[] = [];
		const customFetch = async (_input: string | URL | Request, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			seen.push(`${headers.get("authorization")}/${headers.get("x-static")}`);
			return new Response("", { status: seen.length < 2 ? 500 : 200 });
		};
		await fetchWithRetry("https://example.invalid/auth", {
			headers: { authorization: "stale", "x-static": "base" },
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			prepareInit: attempt => ({ headers: { authorization: `token-${attempt}` } }),
		});
		expect(seen).toEqual(["token-0/base", "token-1/base"]);
	});

	it("wraps network errors and throws once attempts are exhausted", async () => {
		let attempts = 0;
		const customFetch = async () => {
			attempts += 1;
			throw Object.assign(new Error("fetch failed"), { cause: new Error("ECONNREFUSED 127.0.0.1:1") });
		};
		await expect(
			fetchWithRetry("https://example.invalid/down", { fetch: customFetch, defaultDelayMs: 1, maxAttempts: 3 }),
		).rejects.toThrow("Network error: ECONNREFUSED 127.0.0.1:1");
		expect(attempts).toBe(3);
	});

	/**
	 * THE NAME IS THE CONTRACT, and this module mints three cancellations. A bare
	 * `new Error("Request was aborted")` is a cancellation only to a human: `isAbortError` reads
	 * `name`, so the auth gateway classified such an error as a server fault rather than a client
	 * that closed the request, and the provider retry ladder could recognise it only by matching the
	 * word `aborted` in the sentence — which retried what the caller had just cancelled. Each row is
	 * one mint site, and the message is asserted byte-exact because it is the documented one.
	 */
	it.each([
		[
			"a pre-aborted signal, without fetching",
			(controller: AbortController) => {
				controller.abort();
				return async () => new Response("");
			},
		],
		[
			"a signal that aborts mid-flight",
			(controller: AbortController) => async () => {
				controller.abort();
				throw new Error("socket closed");
			},
		],
		[
			"a transport that reports the abort itself",
			() => async () => {
				throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
			},
		],
	])("throws a named cancellation for %s", async (_label, arrange) => {
		const controller = new AbortController();
		const fetch = arrange(controller);
		let thrown: unknown;

		try {
			await fetchWithRetry("https://example.invalid/aborted", {
				signal: controller.signal,
				fetch,
				defaultDelayMs: 1,
				maxAttempts: 2,
			});
		} catch (error) {
			thrown = error;
		}

		expect(isAbortError(thrown)).toBe(true);
		expect((thrown as Error).message).toBe("Request was aborted");
	});

	it("does not fetch at all for a pre-aborted signal", async () => {
		const controller = new AbortController();
		controller.abort();
		let fetched = false;
		await expect(
			fetchWithRetry("https://example.invalid/aborted", {
				signal: controller.signal,
				fetch: async () => {
					fetched = true;
					return new Response("");
				},
			}),
		).rejects.toThrow("Request was aborted");
		expect(fetched).toBe(false);
	});
});

describe("extractRetryHint", () => {
	const headerResponse = (headers: Record<string, string>) => new Response("", { status: 429, headers });

	it("reads retry-after-ms, Retry-After seconds, and x-ratelimit-reset-after", () => {
		expect(extractRetryHint(headerResponse({ "retry-after-ms": "250" }))).toBe(250);
		expect(extractRetryHint(headerResponse({ "retry-after": "2" }))).toBe(2000);
		expect(extractRetryHint(headerResponse({ "x-ratelimit-reset-after": "3" }))).toBe(3000);
	});

	it("treats small x-ratelimit-reset-ms values as delta milliseconds", () => {
		expect(extractRetryHint(headerResponse({ "x-ratelimit-reset-ms": "1500" }))).toBe(1500);
	});

	it("accepts a bare Headers object and returns undefined with no signal", () => {
		expect(extractRetryHint(new Headers({ "retry-after-ms": "42" }))).toBe(42);
		expect(extractRetryHint(new Headers())).toBeUndefined();
		expect(extractRetryHint(null)).toBeUndefined();
	});

	it("parses quota-reset durations from the body", () => {
		expect(extractRetryHint(null, "Your quota will reset after 1h2m3s")).toBe(((1 * 60 + 2) * 60 + 3) * 1000);
		expect(extractRetryHint(null, "reset after 39s")).toBe(39_000);
	});

	it("parses Please-retry, retryDelay JSON fields, and try-again phrasing", () => {
		expect(extractRetryHint(null, "Please retry in 250ms")).toBe(250);
		expect(extractRetryHint(null, '"retryDelay": "34.5s"')).toBe(34_500);
		expect(extractRetryHint(null, "try again in ~158 min.")).toBe(158 * 60_000);
		expect(extractRetryHint(null, "try again in 2h")).toBe(2 * 60 * 60_000);
		expect(extractRetryHint(null, "try again in 90 minutes")).toBe(90 * 60_000);
	});

	it("returns undefined for bodies without any recognized pattern", () => {
		expect(extractRetryHint(null, "just an error")).toBeUndefined();
	});
});

// `resetHeaderTargetMs` is the single owner of the epoch-vs-delta magnitude
// classification shared by every rate-limit `reset`-header parser (the
// `x-ratelimit-reset-ms` branch here in `extractRetryHint`, and `parseResetHeader`
// in the ai package). A `reset` field overloads three shapes onto one number:
// a Unix epoch in ms, a Unix epoch in seconds, or a plain wait delta. These
// tests pin the exact magnitude bands and the strict `>` boundaries so the two
// callers can never drift apart, and so a future edit that loosens a threshold
// (e.g. `>=` instead of `>`, or a shifted power of ten) fails loudly here.
describe("resetHeaderTargetMs", () => {
	it("treats values above 1e12 as an absolute epoch already in milliseconds", () => {
		// A present-day ms epoch (~1.7e12) is returned verbatim as the target instant.
		expect(resetHeaderTargetMs(1_700_000_000_000)).toEqual({ atMs: 1_700_000_000_000 });
	});

	it("treats values in (1e9, 1e12] as an epoch in seconds and scales to milliseconds", () => {
		// A present-day second epoch (~1.7e9) is multiplied by 1000 to reach ms.
		expect(resetHeaderTargetMs(1_700_000_000)).toEqual({ atMs: 1_700_000_000_000 });
	});

	it("treats values at or below 1e9 as a plain wait delta, not a timestamp", () => {
		// 1500 is a Discord-style `x-ratelimit-reset-ms` delta, kept as a delta.
		expect(resetHeaderTargetMs(1500)).toEqual({ delta: true });
		expect(resetHeaderTargetMs(0)).toEqual({ delta: true });
	});

	// The classification uses strict `>` against both thresholds, so a value
	// landing exactly on a boundary falls into the LOWER band. These lock that
	// edge so nobody silently flips a boundary to `>=`.
	it("classifies a value exactly at RESET_EPOCH_S_MIN as a delta, not a seconds epoch", () => {
		expect(RESET_EPOCH_S_MIN).toBe(1e9);
		expect(resetHeaderTargetMs(RESET_EPOCH_S_MIN)).toEqual({ delta: true });
		// One above the boundary crosses into the seconds-epoch band.
		expect(resetHeaderTargetMs(RESET_EPOCH_S_MIN + 1)).toEqual({ atMs: (1e9 + 1) * 1000 });
	});

	it("classifies a value exactly at RESET_EPOCH_MS_MIN as a seconds epoch, not a ms epoch", () => {
		expect(RESET_EPOCH_MS_MIN).toBe(1e12);
		expect(resetHeaderTargetMs(RESET_EPOCH_MS_MIN)).toEqual({ atMs: 1e12 * 1000 });
		// One above the boundary is a ms epoch returned verbatim.
		expect(resetHeaderTargetMs(RESET_EPOCH_MS_MIN + 1)).toEqual({ atMs: 1e12 + 1 });
	});
});

describe("extractHttpStatusFromError", () => {
	it("reads status fields, coercing strings", () => {
		expect(extractHttpStatusFromError({ status: 429 })).toBe(429);
		expect(extractHttpStatusFromError({ statusCode: "503" })).toBe(503);
		expect(extractHttpStatusFromError({ response: { status: 401 } })).toBe(401);
	});

	it("falls back to message patterns", () => {
		expect(extractHttpStatusFromError(new Error("Error: 401 unauthorized"))).toBe(401);
		expect(extractHttpStatusFromError(new Error("upstream error (429)"))).toBe(429);
		expect(extractHttpStatusFromError(new Error("HTTP 503 from gateway"))).toBe(503);
		expect(extractHttpStatusFromError(new Error("got a 502 error"))).toBe(502);
	});

	it("walks the cause chain up to depth 2 and rejects out-of-range codes", () => {
		const nested = new Error("outer");
		(nested as Error & { cause: unknown }).cause = { cause: { status: 500 } };
		expect(extractHttpStatusFromError(nested)).toBe(500);
		expect(extractHttpStatusFromError({ status: 999 })).toBeUndefined();
		expect(extractHttpStatusFromError("not an object")).toBeUndefined();
	});

	/**
	 * WHY: the loosest pattern read any three-digit number followed by
	 * capitalised words as a status line, so `Processed 200 Total Records` came
	 * back as a success and `gave up after 401 Failed Attempts` came back as an
	 * expired credential — and 401 is what `isAuthError` rotates credentials on.
	 * A reason phrase is now evidence only when it is the phrase that belongs to
	 * the code beside it, which `node:http` owns.
	 *
	 * Not caught: a non-standard phrase a gateway invents for a standard code,
	 * which is now read as no status rather than as the wrong one.
	 */
	it("reads a reason phrase only when it is the phrase for that code", () => {
		expect(extractHttpStatusFromError(new Error("429 Too Many Requests"))).toBe(429);
		expect(extractHttpStatusFromError(new Error("upstream said 502 Bad Gateway, giving up"))).toBe(502);
		expect(extractHttpStatusFromError(new Error("503 Service Unavailable"))).toBe(503);
		// A phrase belonging to a different code is not that code's status line.
		expect(extractHttpStatusFromError(new Error("Processed 200 Total Records"))).toBeUndefined();
		expect(extractHttpStatusFromError(new Error("gave up after 401 Failed Attempts"))).toBeUndefined();
		expect(extractHttpStatusFromError(new Error("Read 503 Bytes Total"))).toBeUndefined();
		// The phrase has to end on a word boundary.
		expect(extractHttpStatusFromError(new Error("503 Service Unavailableish"))).toBeUndefined();
	});

	it("prefers an explicitly labelled status over a reason phrase later in the message", () => {
		expect(extractHttpStatusFromError(new Error("status: 418, body said 503 Service Unavailable"))).toBe(418);
	});
});

describe("retryability predicates", () => {
	it("isRetryableStatus: 5xx, 408, 429 only", () => {
		expect(isRetryableStatus(500)).toBe(true);
		expect(isRetryableStatus(408)).toBe(true);
		expect(isRetryableStatus(429)).toBe(true);
		expect(isRetryableStatus(404)).toBe(false);
		expect(isRetryableStatus(200)).toBe(false);
	});

	it("isUnexpectedSocketCloseMessage matches Bun's phrasings", () => {
		expect(isUnexpectedSocketCloseMessage("The socket connection was closed unexpectedly.")).toBe(true);
		expect(isUnexpectedSocketCloseMessage("socket connection closed unexpectedly")).toBe(true);
		expect(isUnexpectedSocketCloseMessage("connection reset by peer")).toBe(false);
	});

	/**
	 * The composite retry decision moved to `@veyyon/ai/error`'s registry, and the four cases that used
	 * to be asserted here (an abort, a timeout, transient wording, a validation shape) moved with it to
	 * `packages/ai/test/one-predicate-decides-whether-a-provider-failure-is-retried.test.ts`. What is
	 * left in this module is what a transport states about itself, which is what the two assertions
	 * above cover. This one refuses the return of a second opinion.
	 */
	it("states transport facts and no retry decision", () => {
		expect("isRetryableError" in fetchRetry).toBe(false);
	});
});
