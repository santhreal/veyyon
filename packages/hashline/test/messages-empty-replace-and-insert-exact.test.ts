/**
 * EMPTY_REPLACE and EMPTY_INSERT exact fragments.
 */
import { describe, expect, it } from "bun:test";
import { EMPTY_INSERT, EMPTY_REPLACE } from "../src/messages";
import { HL_RANGE_SEP } from "../src/format";

describe("EMPTY_REPLACE and EMPTY_INSERT exact", () => {
	it("EMPTY_REPLACE", () => {
		expect(EMPTY_REPLACE).toContain(`SWAP N${HL_RANGE_SEP}M:`);
		expect(EMPTY_REPLACE).toContain("DEL");
	});
	it("EMPTY_INSERT", () => {
		expect(EMPTY_INSERT).toBe("`INS` needs at least one `+TEXT` body row.");
	});
});
