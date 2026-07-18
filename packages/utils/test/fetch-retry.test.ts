import { describe, expect, it } from "bun:test";
import {
	extractHttpStatusFromError,
	extractRetryHint,
	fetchWithRetry,
	isRetryableError,
	isRetryableStatus,
	isUnexpectedSocketCloseMessage,
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

	it("throws 'Request was aborted' for a pre-aborted signal without fetching", async () => {
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

	it("isRetryableError: aborts/timeouts and transient phrases retry", () => {
		expect(isRetryableError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
		expect(isRetryableError(new Error("request timed out"))).toBe(true);
		expect(isRetryableError(new Error("model is overloaded"))).toBe(true);
		expect(isRetryableError(new Error("fetch failed"))).toBe(true);
	});

	it("isRetryableError: non-408/429 4xx and validation shapes fail fast", () => {
		expect(isRetryableError({ status: 401, message: "unauthorized" })).toBe(false);
		expect(isRetryableError({ status: 429, message: "rate limited" })).toBe(true);
		expect(isRetryableError(new Error("schema validation failed"))).toBe(false);
		expect(isRetryableError(new Error("completely unknown"))).toBe(false);
	});
});
