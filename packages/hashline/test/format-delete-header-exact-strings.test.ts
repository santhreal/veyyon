/**
 * formatDeleteHeader exact string forms.
 */
import { describe, expect, it } from "bun:test";
import { formatDeleteHeader } from "@veyyon/hashline";

describe("formatDeleteHeader exact strings", () => {
	for (let n = 1; n <= 10; n++) {
		it(`single ${n}`, () => {
			expect(formatDeleteHeader(n)).toBe(`DEL ${n}`);
			expect(formatDeleteHeader(n, n)).toBe(`DEL ${n}`);
		});
	}
	it("ranges", () => {
		expect(formatDeleteHeader(1, 2)).toBe("DEL 1.=2");
		expect(formatDeleteHeader(3, 9)).toBe("DEL 3.=9");
		expect(formatDeleteHeader(100, 200)).toBe("DEL 100.=200");
	});
});
