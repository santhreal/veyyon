/**
 * Exa result formatting and the search-shape predicate.
 *
 * WHY THIS SUITE EXISTS. `isSearchResponse` is an `in`-check, not a
 * results-array check: a payload that only has `searchTime` is treated
 * as a search. `formatSearchResults` then walks `results ?? []` and
 * interpolates `costDollars.total.toFixed` without guarding `total`.
 * `searchTime: 0` is omitted by `if (data.searchTime)` — pin that so a
 * silent `> 0` vs truthy swap is visible. No network.
 */
import { describe, expect, it } from "bun:test";
import {
	formatGenericResponse,
	formatSearchResults,
	isSearchResponse,
} from "@veyyon/coding-agent/exa/mcp-client";
import { getExaMcpTools } from "@veyyon/coding-agent/exa/tools";
import type { ExaSearchResponse } from "@veyyon/coding-agent/exa/types";

describe("isSearchResponse is an 'in' check, not a results-length check", () => {
	it("accepts an object that only has searchTime, including 0", () => {
		expect(isSearchResponse({ searchTime: 0 })).toBe(true);
		expect(isSearchResponse({ costDollars: { total: 0 } })).toBe(true);
		expect(isSearchResponse({ results: undefined })).toBe(true);
	});

	it("rejects null, arrays, and objects that only look related by name", () => {
		expect(isSearchResponse(null)).toBe(false);
		expect(isSearchResponse([])).toBe(false);
		expect(isSearchResponse({ result: [] })).toBe(false);
		expect(isSearchResponse({ Results: [] })).toBe(false);
	});
});

describe("formatSearchResults does not invent titles and must not crash on cost", () => {
	it("returns the empty-copy when results is missing, not 'undefined'", () => {
		expect(formatSearchResults({} as ExaSearchResponse)).toBe("No results found.");
		expect(formatSearchResults({ results: [] })).toBe("No results found.");
	});

	it("must not throw when costDollars is present but total is missing", () => {
		expect(() =>
			formatSearchResults({ results: [{ title: "T" }], costDollars: {} as { total: number } }),
		).not.toThrow();
	});

	it("formats cost with four decimals and searchTime with two, including 0", () => {
		const out = formatSearchResults({
			results: [{ title: "T" }],
			costDollars: { total: 0 },
			searchTime: 0,
		});
		expect(out).toContain("**Cost:** $0.0000");
		expect(out).toContain("**Search Time:** 0.00s");
	});
});

describe("formatGenericResponse keeps primitives and own keys", () => {
	it("stringifies false and 0 instead of treating them as missing", () => {
		expect(formatGenericResponse(false)).toBe("false");
		expect(formatGenericResponse(0)).toBe("0");
	});

	it("joins MCP text content blocks and ignores non-text parts", () => {
		expect(
			formatGenericResponse({
				content: [
					{ type: "image", text: "ignore" },
					{ type: "text", text: "one" },
					{ type: "text", text: "" },
					{ type: "text", text: "two" },
				],
			}),
		).toBe("one\ntwo");
	});

	it("does not walk inherited enumerable keys as MCP fields", () => {
		const proto = { inherited: "secret" };
		const body = Object.create(proto);
		body.own = "ok";
		const out = formatGenericResponse(body);
		expect(out).toContain("**own:** ok");
		expect(out).not.toContain("inherited");
	});
});

describe("getExaMcpTools does not probe the network when nothing is enabled", () => {
	it("returns [] when both halves are off, even if EXA_API_KEY is set", async () => {
		expect(await getExaMcpTools({ researcher: false, websets: false })).toEqual([]);
	});
});
