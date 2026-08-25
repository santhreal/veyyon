/**
 * Leniency already refuses `*** Update File:` / `*** Add File:`, `@@ -1,3 +1,3 @@`,
 * `DEL 2:` with a body, and a bare `2` hunk header. This file pins the gaps:
 * trimStart still matches an indented sentinel, a payload mention is not an op,
 * Delete/Move sentinels, a count-less `@@`, and hyphen / `.=` bare ranges.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "@veyyon/hashline";

function contamination(text: string): string {
	try {
		parsePatch(text);
		throw new Error("expected parsePatch to refuse contamination, but it returned");
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("expected parsePatch")) throw err;
		return err instanceof Error ? err.message : String(err);
	}
}

describe("sentinels leniency does not name", () => {
	it("still flags an indented Update File: because trimStart is the match point", () => {
		expect(contamination("    *** Update File: src/foo.ts\n")).toMatch(/apply_patch sentinel/);
	});

	it("names *** Delete File: and *** Move to: as apply_patch sentinels", () => {
		expect(contamination("*** Delete File: a.ts\n")).toMatch(/apply_patch sentinel/);
		expect(contamination("*** Move to: b.ts\n")).toMatch(/apply_patch sentinel/);
	});

	it("does not treat a payload line that merely mentions Update File as a sentinel", () => {
		const parsed = parsePatch("[foo.ts#ABCD]\nSWAP 1.=1:\n+see *** Update File: in a comment\n");
		expect(parsed.warnings.join("\n")).not.toMatch(/apply_patch sentinel/);
	});
});

describe("unified-diff and bare-range forms leniency does not name", () => {
	it("names a bare @@ header without counts", () => {
		const w = contamination("@@ foo @@\n");
		expect(w).toMatch(/@@/);
		expect(w).toMatch(/not valid in hashline/);
	});

	it("does not treat a payload `@@` after a verb as a hunk header", () => {
		const parsed = parsePatch("[foo.ts#ABCD]\nSWAP 1.=1:\n+const x = '@@ -1,1 +1,1 @@';\n");
		expect(parsed.warnings.join("\n")).not.toMatch(/unified-diff hunk header/);
	});

	it("tells the operator a bare 12-15 or 12.=15 range needs SWAP or DEL", () => {
		expect(contamination("12-15\n")).toMatch(/bare range hunk header/);
		expect(contamination("12.=15\n")).toMatch(/bare range hunk header/);
	});
});
