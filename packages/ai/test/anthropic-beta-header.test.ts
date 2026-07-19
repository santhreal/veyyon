/**
 * Contract tests for buildBetaHeader, which assembles the `anthropic-beta`
 * request header from a base list plus caller-supplied extras. A malformed
 * header (duplicate tokens, stray whitespace, empty entries, or reordered
 * tokens) is sent to the API on every request, so these pin the exact string.
 */
import { describe, expect, it } from "bun:test";
import { buildBetaHeader } from "@veyyon/ai/providers/anthropic";

describe("buildBetaHeader", () => {
	it("joins base then extra betas with commas, preserving order", () => {
		expect(buildBetaHeader(["a", "b"], ["c"])).toBe("a,b,c");
		// Base tokens always precede extras.
		expect(buildBetaHeader(["z"], ["a"])).toBe("z,a");
	});

	it("drops duplicates across and within the lists, keeping first position", () => {
		expect(buildBetaHeader(["a", "b"], ["b", "c", "a"])).toBe("a,b,c");
		expect(buildBetaHeader(["x", "x"], [])).toBe("x");
	});

	it("trims each token and deduplicates on the trimmed value", () => {
		expect(buildBetaHeader([" a ", "b"], ["a "])).toBe("a,b");
	});

	it("skips empty and whitespace-only entries", () => {
		expect(buildBetaHeader(["a", "", "  "], ["", "d"])).toBe("a,d");
	});

	it("returns an empty string when there are no usable tokens", () => {
		expect(buildBetaHeader([], [])).toBe("");
		expect(buildBetaHeader(["", "   "], [" "])).toBe("");
	});
});
