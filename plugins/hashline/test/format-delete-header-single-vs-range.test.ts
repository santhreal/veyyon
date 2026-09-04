/**
 * formatDeleteHeader single-line form omits .= when start===end.
 */
import { describe, expect, it } from "bun:test";
import { formatDeleteHeader } from "@veyyon/hashline";

describe("formatDeleteHeader single vs range form", () => {
	for (let n = 1; n <= 20; n++) {
		it(`single ${n}`, () => {
			expect(formatDeleteHeader(n)).toBe(`DEL ${n}`);
			expect(formatDeleteHeader(n, n)).toBe(`DEL ${n}`);
			expect(formatDeleteHeader(n, n + 1)).toBe(`DEL ${n}.=${n + 1}`);
		});
	}
});
