/**
 * insert-after-block lowering warning exact strings.
 */
import { describe, expect, it } from "bun:test";
import { insertAfterBlockCloserLoweredWarning, insertAfterBlockUnresolvedLoweredWarning } from "../src/messages";

describe("insert-after-block warning exact", () => {
	for (const line of [1, 4, 12, 99]) {
		it(`closer line ${line}`, () => {
			const m = insertAfterBlockCloserLoweredWarning(line);
			expect(m).toContain(`INS.BLK.POST ${line}:`);
			expect(m).toContain(`INS.POST ${line}:`);
		});
		it(`unresolved line ${line}`, () => {
			const m = insertAfterBlockUnresolvedLoweredWarning(line);
			expect(m).toContain(`INS.BLK.POST ${line}:`);
			expect(m).toContain("could not resolve");
			expect(m).toContain(`INS.POST ${line}:`);
		});
	}
});
