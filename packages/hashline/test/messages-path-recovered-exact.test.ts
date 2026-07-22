/**
 * pathRecoveredFromTagMessage exact fragments.
 */
import { describe, expect, it } from "bun:test";
import { pathRecoveredFromTagMessage } from "../src/messages";
import { HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "../src/format";

describe("pathRecoveredFromTagMessage exact", () => {
	it("names authored and resolved paths", () => {
		const m = pathRecoveredFromTagMessage("util.ts", "pkg/src/util.ts", "ABCD");
		expect(m).toContain('"util.ts"');
		expect(m).toContain("pkg/src/util.ts");
		expect(m).toContain(`${HL_FILE_HASH_SEP}ABCD`);
		expect(m).toContain(`${HL_FILE_PREFIX}pkg/src/util.ts${HL_FILE_HASH_SEP}TAG${HL_FILE_SUFFIX}`);
	});

	it("works for deep paths", () => {
		const m = pathRecoveredFromTagMessage("x.ts", "a/b/c/x.ts", "12EF");
		expect(m).toContain("a/b/c/x.ts");
		expect(m).toContain(`${HL_FILE_HASH_SEP}12EF`);
	});
});
