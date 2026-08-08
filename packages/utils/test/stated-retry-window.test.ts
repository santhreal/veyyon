/**
 * A provider that states when it will accept traffic again must be believed.
 *
 * Error telemetry across 759 sessions showed 85 consecutive `429 rate_limit`
 * turns, the single largest failure bucket. Retrying inside a window the server
 * already named is guaranteed to fail, so each of those attempts burned budget
 * and added load without any chance of succeeding. These tests pin the two
 * places a stated window arrives — response headers and the error prose the
 * headers were folded into — and the bounds that keep a hostile or skewed clock
 * from turning "wait" into "wait forever".
 *
 * The Anthropic bucket coverage is derived from {@link ANTHROPIC_RESET_HEADERS}
 * at run time rather than listed here, so adding a rate-limit bucket to the
 * registry immediately puts it under every assertion below instead of shipping
 * unread.
 */
import { describe, expect, it } from "bun:test";
import { ANTHROPIC_RESET_HEADERS, anthropicResetDelayMs, extractRetryHint, fetchWithRetry } from "../src/fetch-retry";

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

function iso(offsetMs: number): string {
	return new Date(NOW + offsetMs).toISOString();
}

function jsonResponse(status: number, headers: Record<string, string> = {}): Response {
	return new Response("{}", { status, headers });
}

describe("Anthropic rate-limit reset clocks", () => {
	it("reads a window from every registered bucket, in both wire spellings", () => {
		for (const { reset } of ANTHROPIC_RESET_HEADERS) {
			expect(anthropicResetDelayMs(new Headers({ [reset]: iso(5 * MINUTE) }), NOW)).toBe(5 * MINUTE);
			expect(anthropicResetDelayMs(new Headers({ [reset]: String((NOW + 5 * MINUTE) / 1000) }), NOW)).toBe(
				5 * MINUTE,
			);
		}
	});

	it("prefers the bucket that actually rejected the request over a shorter innocent one", () => {
		// Every registered bucket must be able to be the exhausted one. Pair it
		// against a sibling with a much shorter clock and plenty of headroom: the
		// exhausted bucket's longer window has to win, because retrying while it
		// is still empty fails again no matter what the other bucket says.
		for (const { reset, remaining } of ANTHROPIC_RESET_HEADERS) {
			const sibling = ANTHROPIC_RESET_HEADERS.find(entry => entry.reset !== reset);
			expect(sibling).toBeDefined();
			const headers = new Headers({
				[reset]: iso(20 * MINUTE),
				[remaining]: "0",
				[sibling!.reset]: iso(MINUTE),
				[sibling!.remaining]: "4000",
			});
			expect(anthropicResetDelayMs(headers, NOW)).toBe(20 * MINUTE);
		}
	});

	it("waits out the longest empty bucket when more than one rejected", () => {
		// Falsification: with a single exhausted bucket, "longest exhausted" and
		// "shortest exhausted" are the same value, so a rule inverted to MIN
		// still passed. Two empty buckets separate them, and MIN is the harmful
		// answer: it returns while the other bucket is provably still empty.
		for (const { reset, remaining } of ANTHROPIC_RESET_HEADERS) {
			const sibling = ANTHROPIC_RESET_HEADERS.find(entry => entry.reset !== reset);
			expect(sibling).toBeDefined();
			const headers = new Headers({
				[reset]: iso(20 * MINUTE),
				[remaining]: "0",
				[sibling!.reset]: iso(3 * MINUTE),
				[sibling!.remaining]: "0",
			});
			expect(anthropicResetDelayMs(headers, NOW)).toBe(20 * MINUTE);
		}
	});

	it("falls back to the shortest clock when nothing says which bucket rejected", () => {
		// No `-remaining` evidence means we cannot tell which limit was hit.
		// Under-waiting costs one more retry; over-waiting on a guess strands the
		// caller behind a window that may not even apply to them.
		const headers = new Headers();
		for (const [position, { reset }] of ANTHROPIC_RESET_HEADERS.entries()) {
			headers.set(reset, iso((position + 2) * MINUTE));
		}
		expect(anthropicResetDelayMs(headers, NOW)).toBe(2 * MINUTE);
	});

	it("treats a rejected unified status as exhaustion even with no remaining count", () => {
		const headers = new Headers({
			"anthropic-ratelimit-unified-reset": iso(30 * MINUTE),
			"anthropic-ratelimit-unified-status": "rejected",
			"anthropic-ratelimit-requests-reset": iso(MINUTE),
		});
		expect(anthropicResetDelayMs(headers, NOW)).toBe(30 * MINUTE);
	});

	it("ignores a clock that already passed or sits past the hold ceiling", () => {
		// Termination bound. A reset clock is provider-controlled data, and a
		// skewed or malformed one must not translate into an unbounded stand-down.
		for (const { reset, remaining } of ANTHROPIC_RESET_HEADERS) {
			expect(anthropicResetDelayMs(new Headers({ [reset]: iso(-MINUTE), [remaining]: "0" }), NOW)).toBeUndefined();
			expect(
				anthropicResetDelayMs(new Headers({ [reset]: iso(25 * 60 * MINUTE), [remaining]: "0" }), NOW),
			).toBeUndefined();
			expect(anthropicResetDelayMs(new Headers({ [reset]: "not-a-clock" }), NOW)).toBeUndefined();
		}
		expect(anthropicResetDelayMs(new Headers(), NOW)).toBeUndefined();
	});

	it("pairs every reset clock with the sibling counter that names its bucket", () => {
		// The pairing convention is what lets the exhausted bucket be identified.
		// A new entry that breaks it would silently lose that identification, so
		// the registry itself is asserted rather than assumed.
		for (const { reset, remaining } of ANTHROPIC_RESET_HEADERS) {
			expect(reset.startsWith("anthropic-ratelimit-")).toBe(true);
			expect(remaining).toBe(reset.replace(/-reset$/, "-remaining"));
		}
	});

	it("registers every rate-limit bucket Anthropic reports a reset clock for", () => {
		// Falsification: the assertions above are derived from this registry, so
		// deleting an entry deletes its own coverage and every one of them stayed
		// green while a whole bucket went unread. The header names are a provider
		// protocol constant, not an implementation choice, so the set is pinned:
		// dropping or renaming one is a behaviour change that has to be recorded
		// here, and adding one still reaches every assertion above automatically.
		expect(ANTHROPIC_RESET_HEADERS.map(entry => entry.reset).sort()).toEqual([
			"anthropic-ratelimit-input-tokens-reset",
			"anthropic-ratelimit-output-tokens-reset",
			"anthropic-ratelimit-requests-reset",
			"anthropic-ratelimit-tokens-reset",
			"anthropic-ratelimit-unified-reset",
		]);
	});
});

describe("extractRetryHint", () => {
	it("reads the millisecond hint this codebase appends to a provider message", () => {
		// `formatErrorMessageWithRetryAfter` writes exactly this spelling onto the
		// error text, and the auth gateway then asks for the window with the
		// headers long gone: `extractRetryHint(undefined, message)`. Until the
		// pattern existed the gateway could not read the hint we had just written
		// for it, so an exhausted account was blocked for a flat default and
		// returned to the pool while the provider was still refusing it.
		expect(extractRetryHint(undefined, "429 rate_limit_error retry-after-ms=62000")).toBe(62_000);
		expect(extractRetryHint(undefined, "429 rate_limit_error retry-after-ms: 62000")).toBe(62_000);
	});

	it("reads the seconds spelling providers write into prose", () => {
		expect(extractRetryHint(undefined, "429 Rate limit exceeded. Please try again later. retry-after 60")).toBe(
			60_000,
		);
		expect(extractRetryHint(undefined, "429 Rate limit exceeded. retry-after: 60")).toBe(60_000);
	});

	it("keeps the provider's own retry-after ahead of its reset clocks", () => {
		// The reset clocks say when a bucket refills; `retry-after` is the direct
		// answer to "how long should you wait". Anthropic documents the latter as
		// authoritative, so the clocks are a fallback and never an override.
		const response = jsonResponse(429, {
			"retry-after": "7",
			"anthropic-ratelimit-unified-reset": iso(45 * MINUTE),
			"anthropic-ratelimit-unified-remaining": "0",
		});
		expect(extractRetryHint(response)).toBe(7000);
	});

	it("still finds a window when the provider sent reset clocks and no retry-after", () => {
		const response = jsonResponse(429, {
			"anthropic-ratelimit-input-tokens-reset": new Date(Date.now() + 90_000).toISOString(),
			"anthropic-ratelimit-input-tokens-remaining": "0",
		});
		const hint = extractRetryHint(response);
		expect(hint).toBeGreaterThan(80_000);
		expect(hint).toBeLessThanOrEqual(90_000);
	});
});

describe("fetchWithRetry transient recovery", () => {
	it("backs off a transient overload and then succeeds, within its attempt budget", async () => {
		const statuses = [503, 503, 200];
		let attempts = 0;
		const delays: number[] = [];
		const response = await fetchWithRetry("https://example.test/v1", {
			maxAttempts: 5,
			defaultDelayMs: attempt => {
				delays.push(attempt);
				return 0;
			},
			fetch: async () => jsonResponse(statuses[attempts++]!),
		});
		expect(response.status).toBe(200);
		expect(attempts).toBe(3);
		// One backoff per retry, and the schedule is driven by the attempt index,
		// so the sequence grows rather than hammering at a fixed rate.
		expect(delays).toEqual([0, 1]);
	});

	it("stops rather than sleeping past its cap when the provider names a longer window", async () => {
		// Termination bound: a stated window wider than the caller's ceiling ends
		// the loop and hands the failure back, instead of parking the request.
		let attempts = 0;
		const response = await fetchWithRetry("https://example.test/v1", {
			maxAttempts: 5,
			maxDelayMs: 1500,
			fetch: async () => {
				attempts++;
				return jsonResponse(429, { "retry-after": "2" });
			},
		});
		expect(response.status).toBe(429);
		expect(attempts).toBe(1);
	});

	it("honours a stated window that fits under the cap and retries after it", async () => {
		const statuses = [429, 200];
		let attempts = 0;
		const response = await fetchWithRetry("https://example.test/v1", {
			maxAttempts: 5,
			maxDelayMs: 1500,
			fetch: async () => jsonResponse(statuses[attempts++]!, { "retry-after-ms": "1" }),
		});
		expect(response.status).toBe(200);
		expect(attempts).toBe(2);
	});

	it("gives up at the attempt budget instead of retrying forever", async () => {
		let attempts = 0;
		const response = await fetchWithRetry("https://example.test/v1", {
			maxAttempts: 3,
			defaultDelayMs: 0,
			fetch: async () => {
				attempts++;
				return jsonResponse(503);
			},
		});
		expect(response.status).toBe(503);
		expect(attempts).toBe(3);
	});
});
