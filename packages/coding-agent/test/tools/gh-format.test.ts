import { describe, expect, it } from "bun:test";
import { formatShortSha } from "@veyyon/coding-agent/tools/gh-format";

/**
 * formatShortSha is shared between GitHub tool argument normalization and the
 * run-watch renderer, so its contract must be identical for both callers. It
 * returns the first 12 hex characters, and treats BOTH undefined and the empty
 * string as "no SHA" (returns undefined), which is why callers can pass an
 * optional SHA straight through without a length check. A regression that returned
 * "" for an empty input would render an empty short-SHA instead of omitting it.
 */

describe("formatShortSha", () => {
	it("returns undefined for undefined", () => {
		expect(formatShortSha(undefined)).toBeUndefined();
	});

	it("returns undefined for an empty string (not an empty slice)", () => {
		expect(formatShortSha("")).toBeUndefined();
	});

	it("returns a shorter SHA unchanged", () => {
		expect(formatShortSha("abc")).toBe("abc");
	});

	it("truncates a full SHA to exactly 12 characters", () => {
		expect(formatShortSha("0123456789abcdef0123")).toBe("0123456789ab");
	});
});
