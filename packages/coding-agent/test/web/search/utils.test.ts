/**
 * Unit coverage for the shared web-search helpers plus a single-owner lock for
 * `collapseWhitespace`. The HTML-scraping providers (google, startpage, mojeek,
 * ecosia, …) all clean extracted result text the same way — collapse every run
 * of whitespace to one space and trim — and used to each re-inline
 * `(x ?? "").replace(/\s+/g, " ").trim()` (two even named a private
 * `normalizeText`). They now share `collapseWhitespace`; the lock fails if a
 * provider re-inlines the idiom instead of importing the owner.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import {
	clampNumResults,
	collapseWhitespace,
	dateToAgeSeconds,
	sanitizeResultLimit,
} from "../../../src/web/search/utils";

describe("collapseWhitespace", () => {
	it("collapses runs of mixed whitespace to single spaces and trims the ends", () => {
		expect(collapseWhitespace("  hello   world  ")).toBe("hello world");
		expect(collapseWhitespace("a\t\tb\n\nc")).toBe("a b c");
		expect(collapseWhitespace("line one\r\n  line two")).toBe("line one line two");
	});

	it("returns an empty string for null, undefined, empty, and all-whitespace input", () => {
		expect(collapseWhitespace(null)).toBe("");
		expect(collapseWhitespace(undefined)).toBe("");
		expect(collapseWhitespace("")).toBe("");
		expect(collapseWhitespace("   \t\n  ")).toBe("");
	});

	it("leaves already-normalized text unchanged", () => {
		expect(collapseWhitespace("clean single spaced text")).toBe("clean single spaced text");
	});
});

describe("clampNumResults", () => {
	it("clamps into [1, max] and falls back on absent/NaN", () => {
		expect(clampNumResults(5, 10, 20)).toBe(5);
		expect(clampNumResults(100, 10, 20)).toBe(20);
		expect(clampNumResults(0, 10, 20)).toBe(10);
		expect(clampNumResults(undefined, 10, 20)).toBe(10);
		expect(clampNumResults(Number.NaN, 10, 20)).toBe(10);
		expect(clampNumResults(-3, 10, 20)).toBe(1);
	});

	// A result count is always a whole number: it is sent verbatim to every
	// provider API as `count`/`limit`/`numResults`, where a fractional value is
	// invalid. This locks the floor so a fractional input can never leak through.
	it("floors a fractional value to a whole result count", () => {
		expect(clampNumResults(5.7, 10, 20)).toBe(5);
		expect(clampNumResults(5.1, 10, 20)).toBe(5);
		expect(clampNumResults(19.999, 10, 20)).toBe(19);
		// A fraction between 0 and 1 is truthy, so it clamps up to the floor of 1,
		// never to 0 (which would ask an API for no results).
		expect(clampNumResults(0.4, 10, 20)).toBe(1);
		expect(clampNumResults(1.9, 10, 20)).toBe(1);
	});

	// Above-max fractional input still lands exactly on the integer cap, and a
	// non-finite Infinity clamps to the cap rather than escaping the bound.
	it("caps oversized and non-finite input at the integer max", () => {
		expect(clampNumResults(20.9, 10, 20)).toBe(20);
		expect(clampNumResults(Number.POSITIVE_INFINITY, 10, 20)).toBe(20);
	});

	// -Infinity and -0 are falsy/at-or-below zero: the guard/clamp must not let a
	// zero or negative count reach a provider.
	it("never returns zero or a negative count", () => {
		expect(clampNumResults(Number.NEGATIVE_INFINITY, 10, 20)).toBe(1);
		expect(clampNumResults(-0, 10, 20)).toBe(10);
		expect(clampNumResults(-100, 10, 20)).toBe(1);
	});
});

describe("sanitizeResultLimit", () => {
	// The no-default-cap providers (jina, gemini, codex, anthropic, synthetic,
	// perplexity) return everything the upstream API/grounding gave unless a real
	// positive limit is set. An absent limit MUST stay absent so the provider
	// keeps returning everything, rather than being forced to a default like
	// clampNumResults does.
	it("returns undefined for any input that is not a real positive limit", () => {
		expect(sanitizeResultLimit(undefined)).toBeUndefined();
		expect(sanitizeResultLimit(0)).toBeUndefined();
		expect(sanitizeResultLimit(0.4)).toBeUndefined();
		expect(sanitizeResultLimit(Number.NaN)).toBeUndefined();
		expect(sanitizeResultLimit(Number.POSITIVE_INFINITY)).toBeUndefined();
		expect(sanitizeResultLimit(Number.NEGATIVE_INFINITY)).toBeUndefined();
	});

	// This is the exact bug the helper closes: a NEGATIVE limit used to reach
	// `sources.slice(0, negative)`, which counts from the END and silently dropped
	// the last N results instead of capping the front. Treating it as "no limit"
	// returns everything, which is the safe, non-lossy behavior.
	it("treats a negative limit as no limit (never drops trailing results)", () => {
		expect(sanitizeResultLimit(-1)).toBeUndefined();
		expect(sanitizeResultLimit(-100)).toBeUndefined();
		// -0 is not >= 1, so it is "no limit" too.
		expect(sanitizeResultLimit(-0)).toBeUndefined();
	});

	it("passes through a valid positive limit, floored to a whole count", () => {
		expect(sanitizeResultLimit(1)).toBe(1);
		expect(sanitizeResultLimit(10)).toBe(10);
		expect(sanitizeResultLimit(5.7)).toBe(5);
		expect(sanitizeResultLimit(1.9)).toBe(1);
		expect(sanitizeResultLimit(999)).toBe(999);
	});
});

describe("dateToAgeSeconds", () => {
	it("returns undefined for absent or unparseable dates", () => {
		expect(dateToAgeSeconds(null)).toBeUndefined();
		expect(dateToAgeSeconds(undefined)).toBeUndefined();
		expect(dateToAgeSeconds("not-a-date")).toBeUndefined();
	});

	it("returns a non-negative age for a past ISO date", () => {
		const age = dateToAgeSeconds(new Date(Date.now() - 60_000).toISOString());
		expect(age).toBeGreaterThanOrEqual(59);
		expect(age).toBeLessThan(120);
	});

	// A future publishedDate (bad provider data or clock skew) yields a negative
	// delta here. dateToAgeSeconds returns the raw signed value; the display
	// boundary (@veyyon/utils formatAge) is what guards `< 0` and renders "". This
	// pins that contract so the negative is not silently reinterpreted upstream.
	it("returns a negative age for a future ISO date", () => {
		const age = dateToAgeSeconds(new Date(Date.now() + 60_000).toISOString());
		expect(age).toBeLessThan(0);
	});
});

describe("collapseWhitespace single-owner lock", () => {
	const providersDir = path.resolve(import.meta.dir, "../../../src/web/search/providers");
	const files = readdirSync(providersDir).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));

	it("scans the provider directory", () => {
		expect(files.length).toBeGreaterThan(5);
	});

	it("no provider re-inlines the collapse-and-trim idiom or a private normalizeText", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const text = readFileSync(path.join(providersDir, file), "utf8");
			if (/replace\(\/\\s\+\/g, " "\)\.trim\(\)/.test(text)) offenders.push(`${file}: inline collapse-and-trim`);
			if (/function\s+normalizeText\s*\(/.test(text)) offenders.push(`${file}: local normalizeText`);
		}
		expect(offenders, "import collapseWhitespace from ../utils instead").toEqual([]);
	});
});

describe("result-limit single-owner lock", () => {
	const providersDir = path.resolve(import.meta.dir, "../../../src/web/search/providers");
	const files = readdirSync(providersDir).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts"));

	// A caller-supplied count must never reach `Array.prototype.slice` raw. Both
	// clampNumResults (default-cap providers) and sanitizeResultLimit (no-cap
	// providers) exist so the count is floored to a whole positive number first.
	// Slicing a raw `params.num_results`/`params.numSearchResults`/`params.limit`
	// is the negative-limit bug that silently drops trailing results. This lock
	// fails if a provider reintroduces a raw slice on an unsanitized param.
	it("no provider slices sources on a raw, unsanitized result count", () => {
		const offenders: string[] = [];
		const rawSlice = /\.slice\(\s*0\s*,\s*params\.(num_results|numSearchResults|limit)\b/;
		for (const file of files) {
			const text = readFileSync(path.join(providersDir, file), "utf8");
			if (rawSlice.test(text)) offenders.push(`${file}: raw slice on params.<count>`);
		}
		expect(offenders, "sanitize the count via sanitizeResultLimit/clampNumResults before slicing").toEqual([]);
	});
});
