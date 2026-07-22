import { describe, expect, it } from "bun:test";
import { formatDeleteHeader, formatReplaceHeader } from "@veyyon/hashline";

/**
 * formatDeleteHeader / formatReplaceHeader same-line and range forms.
 */

describe("format headers same-line and range", () => {
	it("same-line delete includes the line number once or twice", () => {
		for (let n = 1; n <= 30; n++) {
			const h = formatDeleteHeader(n, n);
			expect(h).toContain(String(n));
			expect(h.toUpperCase()).toContain("DEL");
		}
	});

	it("same-line replace includes SWAP and line number", () => {
		for (let n = 1; n <= 30; n++) {
			const h = formatReplaceHeader(n, n);
			expect(h).toContain(String(n));
			expect(h.toUpperCase()).toContain("SWAP");
		}
	});

	it("wide range includes both endpoints", () => {
		const h = formatReplaceHeader(1, 1000);
		expect(h).toContain("1");
		expect(h).toContain("1000");
	});
});
