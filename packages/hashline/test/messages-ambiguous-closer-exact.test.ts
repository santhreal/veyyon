/**
 * ambiguousCloserSpareMessage singular/plural exact fragments.
 */
import { describe, expect, it } from "bun:test";
import { HL_RANGE_SEP } from "../src/format";
import { ambiguousCloserSpareMessage } from "../src/messages";

describe("ambiguousCloserSpareMessage exact", () => {
	it("singular", () => {
		const m = ambiguousCloserSpareMessage(2, 10, 10, 1);
		expect(m).toContain(`SWAP 2${HL_RANGE_SEP}10:`);
		expect(m).toContain("line 10");
		expect(m).not.toContain("lines 10-");
	});

	it("plural", () => {
		const m = ambiguousCloserSpareMessage(2, 12, 10, 3);
		expect(m).toContain("lines 10-12");
		expect(m).toContain("INS.PRE");
		expect(m).toContain("INS.POST");
	});
});
