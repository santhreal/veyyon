/**
 * unseenLinesMessage full reveal allows same-tag retry wording.
 */
import { describe, expect, it } from "bun:test";
import { unseenLinesMessage } from "../src/messages";
import { HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "../src/format";

describe("unseenLinesMessage full reveal", () => {
	it("allows straight retry", () => {
		const m = unseenLinesMessage("f.ts", [2], "CAFE", {
			lines: [{ line: 2, text: "secret" }],
			truncated: false,
		});
		expect(m).toContain("  2:secret");
		expect(m).toContain("straight retry");
		expect(m).toContain(`${HL_FILE_PREFIX}path${HL_FILE_HASH_SEP}tag${HL_FILE_SUFFIX}`);
	});
});
