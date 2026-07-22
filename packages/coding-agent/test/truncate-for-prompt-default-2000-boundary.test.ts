/**
 * truncateForPrompt default max 2000: exact boundary identity and +1 elide.
 */
import { describe, expect, it } from "bun:test";
import { truncateForPrompt } from "../src/tools/approval";

describe("truncateForPrompt default 2000 boundary", () => {
	it("1999 identity", () => {
		const s = "a".repeat(1999);
		expect(truncateForPrompt(s)).toBe(s);
	});
	it("2000 identity", () => {
		const s = "a".repeat(2000);
		expect(truncateForPrompt(s)).toBe(s);
	});
	it("2001 elides 1", () => {
		const s = "a".repeat(2001);
		expect(truncateForPrompt(s)).toBe(`${"a".repeat(2000)}[…1ch elided…]`);
	});
	it("2500 elides 500", () => {
		const s = "b".repeat(2500);
		expect(truncateForPrompt(s)).toBe(`${"b".repeat(2000)}[…500ch elided…]`);
	});
});
