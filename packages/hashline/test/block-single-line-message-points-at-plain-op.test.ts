/**
 * A block op that resolved to one line is a mis-anchored statement.
 *
 * WHY THIS SUITE EXISTS. `SWAP.BLK N` only earns its keep when N is the
 * opening line of a multi-line construct (the closer is then inferred). A
 * single-line resolution means N was a bare statement. Pointing the model at
 * `SWAP N.=N:` / `DEL N` / `INS.POST N:` is the fix; leaving the block form
 * in the error without the plain form is how the model retries the same
 * `SWAP.BLK` forever.
 */
import { describe, expect, it } from "bun:test";
import { blockSingleLineMessage } from "../src/messages";

describe("blockSingleLineMessage names both the block form and the one-line form", () => {
	it("replace points at SWAP.BLK N and SWAP N.=N:", () => {
		const m = blockSingleLineMessage(12, "replace");
		expect(m).toContain("`SWAP.BLK 12`");
		expect(m).toContain("`SWAP 12.=12:`");
		expect(m).toContain("bare statement");
		expect(m).not.toContain("DEL.BLK");
	});

	it("delete points at DEL.BLK N and DEL N", () => {
		const m = blockSingleLineMessage(3, "delete");
		expect(m).toContain("`DEL.BLK 3`");
		expect(m).toContain("`DEL 3`");
		expect(m).not.toContain("SWAP.BLK");
	});

	it("insert_after points at INS.BLK.POST N and INS.POST N:", () => {
		const m = blockSingleLineMessage(8, "insert_after");
		expect(m).toContain("`INS.BLK.POST 8`");
		expect(m).toContain("`INS.POST 8:`");
		expect(m).not.toContain("SWAP.BLK");
		expect(m).not.toContain("DEL.BLK");
	});
});
