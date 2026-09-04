/**
 * ambiguousBoundaryEchoMessage leading vs trailing exact substrings.
 */
import { describe, expect, it } from "bun:test";
import { HL_RANGE_SEP } from "../src/format";
import { ambiguousBoundaryEchoMessage } from "../src/messages";

describe("ambiguousBoundaryEchoMessage sides", () => {
	for (const count of [1, 2, 5]) {
		it(`leading count=${count}`, () => {
			const m = ambiguousBoundaryEchoMessage(3, 8, "leading", count);
			expect(m).toContain(`SWAP 3${HL_RANGE_SEP}8:`);
			expect(m).toContain("just above the range");
			expect(m).toContain(`${count} line(s)`);
		});
		it(`trailing count=${count}`, () => {
			const m = ambiguousBoundaryEchoMessage(3, 8, "trailing", count);
			expect(m).toContain("just below the range");
			expect(m).toContain(`${count} line(s)`);
		});
	}
});
