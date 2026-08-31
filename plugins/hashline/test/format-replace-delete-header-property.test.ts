import { describe, expect, it } from "bun:test";
import { formatDeleteHeader, formatReplaceHeader } from "@veyyon/hashline";

/**
 * formatReplaceHeader / formatDeleteHeader include endpoints for many ranges.
 */

describe("formatReplaceHeader / formatDeleteHeader property", () => {
	it("formatReplaceHeader always contains SWAP and both ends for 1..50 ranges", () => {
		for (let start = 1; start <= 30; start++) {
			for (let end = start; end <= Math.min(start + 5, 50); end++) {
				const h = formatReplaceHeader(start, end);
				expect(h.toUpperCase()).toContain("SWAP");
				expect(h).toContain(String(start));
				expect(h).toContain(String(end));
				expect(h.endsWith(":") || h.includes(":")).toBe(true);
			}
		}
	});

	it("formatDeleteHeader always contains DEL and start", () => {
		for (let start = 1; start <= 40; start++) {
			const h = formatDeleteHeader(start, start + 3);
			expect(h.toUpperCase()).toContain("DEL");
			expect(h).toContain(String(start));
		}
	});

	it("same-line replace and delete headers differ", () => {
		const r = formatReplaceHeader(5, 5);
		const d = formatDeleteHeader(5, 5);
		expect(r).not.toBe(d);
		expect(r.toUpperCase()).toContain("SWAP");
		expect(d.toUpperCase()).toContain("DEL");
	});
});
