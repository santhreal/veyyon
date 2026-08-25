/**
 * Exa result formatting and the search-shape predicate.
 *
 * WHY THIS SUITE EXISTS. `isSearchResponse` is an `in`-check, not a
 * results-array check: a payload that only has `searchTime` is treated
 * as a search. `formatSearchResults` then walks `results ?? []` and
 * interpolates `costDollars.total.toFixed` without guarding `total`.
 * The generic formatter must not swallow a bigint/false/empty-content
 * MCP body as "(empty)" when it still has a value. No network.
 */
import { describe, expect, it } from "bun:test";
import {
	formatGenericResponse,
	formatSearchResults,
	isSearchResponse,
} from "@veyyon/coding-agent/exa/mcp-client";
import { getExaMcpTools, RESEARCHER_MCP_TOOL_NAMES } from "@veyyon/coding-agent/exa/tools";
import type { ExaSearchResponse } from "@veyyon/coding-agent/exa/types";

describe("isSearchResponse is an 'in' check, not a results-length check", () => {
	it("accepts an object that only has searchTime, including 0", () => {
		expect(isSearchResponse({ searchTime: 0 })).toBe(true);
		expect(isSearchResponse({ costDollars: { total: 0 } })).toBe(true);
		expect(isSearchResponse({ statuses: [] })).toBe(true);
		expect(isSearchResponse({ results: undefined })).toBe(true);
	});

	it("rejects null, arrays, and objects that only look related by name", () => {
		expect(isSearchResponse(null)).toBe(false);
		expect(isSearchResponse(undefined)).toBe(false);
		expect(isSearchResponse([])).toBe(false);
		expect(isSearchResponse({ result: [] })).toBe(false);
		expect(isSearchResponse({ Results: [] })).toBe(false);
		expect(isSearchResponse("results")).toBe(false);
	});
});

describe("formatSearchResults does not invent titles and must not crash on cost", () => {
	it("returns the empty-copy when results is missing, not 'undefined'", () => {
		expect(formatSearchResults({} as ExaSearchResponse)).toBe("No results found.");
		expect(formatSearchResults({ results: [] })).toBe("No results found.");
	});

	it("uses Untitled when title is absent, and omits URL/author/date/text when missing", () => {
		const out = formatSearchResults({ results: [{ url: "https://example.invalid/a" }] });
		expect(out).toContain("## Untitled");
		expect(out).toContain("**URL:** https://example.invalid/a");
		expect(out).not.toContain("**Author:**");
		expect(out).not.toContain("**Published Date:**");
		expect(out).not.toContain("**Text:**");
		expect(out).not.toContain("**Highlights:**");
	});

	it("renders every highlight as a markdown bullet, including empty string", () => {
		const out = formatSearchResults({
			results: [{ title: "T", highlights: ["", "keep"] }],
		});
		expect(out).toContain("**Highlights:**");
		expect(out).toContain("- ");
		expect(out).toContain("- keep");
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

	it("does not render a negative searchTime as a duration the operator can trust — it still prints the number", () => {
		const out = formatSearchResults({ results: [{ title: "T" }], searchTime: -1.2 });
		expect(out).toContain("**Search Time:** -1.20s");
	});
});

describe("formatGenericResponse keeps primitives and holes", () => {
	it("prints No result. for null and undefined, not the string 'null'", () => {
		expect(formatGenericResponse(null)).toBe("No result.");
		expect(formatGenericResponse(undefined)).toBe("No result.");
	});

	it("returns a string payload verbatim, including the empty string", () => {
		expect(formatGenericResponse("")).toBe("");
		expect(formatGenericResponse("already markdown")).toBe("already markdown");
	});

	it("stringifies false and 0 instead of treating them as missing", () => {
		expect(formatGenericResponse(false)).toBe("false");
		expect(formatGenericResponse(0)).toBe("0");
	});

	it("renders an empty array as (empty), not No result.", () => {
		expect(formatGenericResponse([])).toBe("(empty)");
	});

	it("uses title, then name, then id, then Item N for array objects, and skips those keys in the body", () => {
		const out = formatGenericResponse([
			{ title: "T", name: "N", id: "I", extra: 1 },
			{ name: "N2", id: "I2" },
			{ id: "only-id" },
			{ extra: true },
		]);
		expect(out).toContain("### T");
		expect(out).toContain("### N2");
		expect(out).toContain("### only-id");
		expect(out).toContain("### Item 4");
		expect(out).not.toMatch(/\*\*title:\*\*/);
		expect(out).toContain("**extra:** 1");
		expect(out).toContain("**extra:** true");
	});

	it("formats array primitives as bullets, using an em-dash for null holes", () => {
		const out = formatGenericResponse(["a", null, undefined, 0]);
		expect(out).toContain("- a");
		expect(out).toContain("- —");
		expect(out).toContain("- 0");
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

	it("falls through to (empty) when the only keys are null/undefined", () => {
		expect(formatGenericResponse({ a: null, b: undefined })).toBe("(empty)");
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

	it("does not register websets when the key is missing — empty, not a throw", async () => {
		const prev = process.env.EXA_API_KEY;
		delete process.env.EXA_API_KEY;
		try {
			expect(await getExaMcpTools({ researcher: false, websets: true })).toEqual([]);
		} finally {
			if (prev !== undefined) process.env.EXA_API_KEY = prev;
		}
	});

	it("pins the researcher tool names so a rename cannot ship as a silent empty tools/list filter", () => {
		expect([...RESEARCHER_MCP_TOOL_NAMES]).toEqual(["deep_researcher_start", "deep_researcher_check"]);
	});
});
