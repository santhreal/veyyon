/**
 * A rate-limit header folded into an error message states the same wait as the
 * header itself.
 *
 * The session retry loop kept its own message parser beside
 * `extractRetryHint`, and the two disagreed: the session read
 * `x-ratelimit-reset: 60` and an ISO `retry-after` date from prose, while the
 * auth gateway and the advisor (which call `extractRetryHint` on the same
 * message) did not, and `extractRetryHint` read `retry-after:
 * 2026-01-01T00:00:00Z` as a wait of 2026 seconds. The class is "a header form
 * that one reader understands in prose and another does not". It closes by
 * deriving the prose reading from `RETRY_HINT_HEADERS`, the table the header
 * path walks, and by sweeping that table here: every registered header must
 * have samples below, and every sample must read the same from prose, in every
 * spelling, as from the header.
 *
 * Not caught: a header form read only by a caller's own code outside this
 * module, and prose phrasings with no header name in them (those are pinned by
 * `fetch-retry.test.ts`).
 */
import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { extractRetryHint, RETRY_HINT_HEADERS } from "../src/fetch-retry";

// Whole second, so the IMF-fixdate samples (second precision) are exact.
const NOW = 1_800_000_000_000;

function imf(offsetMs: number): string {
	return new Date(NOW + offsetMs).toUTCString();
}

function iso(offsetMs: number): string {
	return new Date(NOW + offsetMs).toISOString();
}

/** Per header: a value and the exact wait the header states for it. */
const SAMPLES: Record<string, readonly (readonly [value: string, headerMs: number | undefined])[]> = {
	"retry-after-ms": [
		["1500", 1500],
		["0", 0],
	],
	"retry-after": [
		["60", 60_000],
		["0", 0],
		[iso(90_000), 90_000],
		[iso(-90_000), 0],
		[imf(90_000), 90_000],
	],
	"x-ratelimit-reset-ms": [
		["1500", 1500],
		[String(NOW + 30_000), 30_000],
		[String(NOW - 1000), undefined],
	],
	"x-ratelimit-reset": [
		["60", 60_000],
		[String(NOW / 1000 + 30), 30_000],
	],
	"x-ratelimit-reset-after": [
		["5", 5000],
		// An epoch-sized value: a misread by the `x-ratelimit-reset` pattern,
		// whose name is a prefix of this one, would state 30s instead.
		[String(NOW / 1000 + 30), (NOW / 1000 + 30) * 1000],
	],
};

function spellings(name: string, value: string): string[] {
	const title = name.replace(/(^|-)([a-z])/g, (_, dash: string, c: string) => dash + c.toUpperCase());
	return [`${name}: ${value}`, `${name}=${value}`, `${name} ${value}`, `${title}: ${value}`];
}

afterEach(() => {
	mock.restore();
});

describe("a retry window written into a message", () => {
	it("has samples for every header the header path reads", () => {
		expect(Object.keys(SAMPLES).sort()).toEqual(RETRY_HINT_HEADERS.map(h => h.name).sort());
	});

	it("reads as the header would, in every spelling, with a zero or elapsed window stating none", () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		for (const { name } of RETRY_HINT_HEADERS) {
			for (const [value, headerMs] of SAMPLES[name]!) {
				expect({ name, value, ms: extractRetryHint(new Headers({ [name]: value })) }).toEqual({
					name,
					value,
					ms: headerMs,
				});
				const textMs = headerMs !== undefined && headerMs > 0 ? headerMs : undefined;
				for (const text of spellings(name, value)) {
					const body = `429 Too Many Requests: rate limited. ${text}, please slow down`;
					expect({ body, ms: extractRetryHint(undefined, body) }).toEqual({ body, ms: textMs });
				}
			}
		}
	});

	it("does not read a longer name's value under a shorter name", () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		// `retry-after` must not read the `-ms=0` tail, and nothing else is stated.
		expect(extractRetryHint(undefined, "429 retry-after-ms=0")).toBeUndefined();
		expect(extractRetryHint(undefined, "429 x-retry-after: 60")).toBeUndefined();
	});

	it("does not read the year of an instant it cannot parse as a number of seconds", () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		expect(extractRetryHint(undefined, "429 retry-after: 2027-01-15 08:00:00")).toBeUndefined();
		expect(extractRetryHint(undefined, "429 x-ratelimit-reset: 2027-01-15")).toBeUndefined();
	});

	it("prefers a named header form over prose phrasing in the same message", () => {
		spyOn(Date, "now").mockReturnValue(NOW);
		expect(extractRetryHint(undefined, "try again in 5s. x-ratelimit-reset: 60")).toBe(60_000);
	});
});
