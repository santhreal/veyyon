import { describe, expect, it } from "bun:test";
import { DATE_ONLY_RE, isDateOnly, isUuid, UUID_RE } from "@veyyon/utils";

/**
 * Behavioral coverage for the identifier/shape validators in src/regex.ts. The
 * alphanumeric word-class primitives (ALNUM_RE, hasAlphanumeric,
 * NON_ALNUM_RUN_RE, ALNUM_WORD_RE) are already exercised in
 * alnum-regex-lock.test.ts, and escapeRegExp in escape-regexp-lock.test.ts;
 * isUuid and isDateOnly had no behavioral test at all. These lock the two
 * contracts that are easy to regress: case-insensitive *anchored* UUID matching,
 * and shape-only *anchored* date matching, plus the non-global flag that keeps
 * repeated `.test()` on the shared instances stable.
 */

describe("isUuid", () => {
	it("accepts a canonical UUID in either case", () => {
		expect(isUuid("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
		expect(isUuid("550E8400-E29B-41D4-A716-446655440000")).toBe(true);
	});

	it("is anchored, so a UUID embedded in a larger string is rejected", () => {
		// An unanchored pattern would let junk through validation by matching a UUID
		// substring; the leading/trailing character cases prove both ends anchor.
		expect(isUuid("550e8400-e29b-41d4-a716-446655440000x")).toBe(false);
		expect(isUuid("x550e8400-e29b-41d4-a716-446655440000")).toBe(false);
		expect(isUuid("not-a-uuid")).toBe(false);
	});

	it("rejects a mis-segmented UUID even with the right character count", () => {
		// Right total length, wrong group boundaries: the 8-4-4-4-12 shape must hold,
		// not merely "32 hex digits and four hyphens somewhere".
		expect(isUuid("550e840-0e29b-41d4-a716-4466554400000")).toBe(false);
	});

	it("is non-global so repeated calls on the shared instance stay stable", () => {
		// A stray `g` flag would make UUID_RE stateful via lastIndex and flip every
		// other call to false.
		expect(UUID_RE.global).toBe(false);
		const u = "550e8400-e29b-41d4-a716-446655440000";
		expect(isUuid(u)).toBe(true);
		expect(isUuid(u)).toBe(true);
	});
});

describe("isDateOnly", () => {
	it("accepts the bare YYYY-MM-DD shape", () => {
		expect(isDateOnly("2024-01-02")).toBe(true);
	});

	it("checks shape only, not calendar validity", () => {
		// The documented contract is explicit: 2024-99-99 has the right shape and
		// matches; range-checking the month/day is a caller concern.
		expect(isDateOnly("2024-99-99")).toBe(true);
	});

	it("requires zero-padded fields and rejects a trailing time component", () => {
		// Anchored and fixed-width: single-digit fields and an ISO time suffix both
		// fail, so a full timestamp is never mistaken for a date-only value.
		expect(isDateOnly("2024-1-2")).toBe(false);
		expect(isDateOnly("2024-01-02T00:00")).toBe(false);
	});

	it("is non-global so repeated calls on the shared instance stay stable", () => {
		expect(DATE_ONLY_RE.global).toBe(false);
		expect(isDateOnly("2024-01-02")).toBe(true);
		expect(isDateOnly("2024-01-02")).toBe(true);
	});
});
