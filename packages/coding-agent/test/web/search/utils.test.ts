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
import { clampNumResults, collapseWhitespace, dateToAgeSeconds } from "../../../src/web/search/utils";

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
