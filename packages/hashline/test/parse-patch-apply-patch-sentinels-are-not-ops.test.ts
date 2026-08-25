/**
 * Hashline parse refuses apply_patch / unified-diff contamination rather than
 * treating those sentinels as unknown ops that become payload.
 *
 * WHY THIS SUITE EXISTS. `Begin Patch` is a silent envelope (already pinned).
 * The sibling sentinels are not silent:
 *
 *   - `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move to:`
 *   - `@@ -N,M +N,M @@` unified-diff hunk headers
 *   - a bare `@@` bracket
 *   - `DEL N.=M:` with a colon (DEL has no body)
 *   - a bare line number with no verb
 *   - a bare range with no verb (`12-15` / `12.=15`)
 *
 * If parse swallows these as content, an apply_patch paste from a model that
 * mixed dialects writes `*** Update File:` into the working tree. The
 * diagnostic has to name the hashline verb the operator should have used.
 *
 * Leading whitespace is trimmed before the match (`trimStart`), so an indented
 * `*** Update File:` is still contamination. A sentinel in the MIDDLE of a
 * payload line is content — only the start of a hashline line is an op.
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

describe("apply_patch file sentinels are contamination, not ops", () => {
	it("names *** Update File: as an apply_patch sentinel", () => {
		const w = contamination("*** Update File: src/foo.ts\n");
		expect(w).toMatch(/apply_patch sentinel/);
		expect(w).toMatch(/Update File:/);
		expect(w).toMatch(/\[path#HASH\]/);
		expect(w).toMatch(/SWAP /);
	});

	it("names *** Add File: / *** Delete File: / *** Move to: the same way", () => {
		for (const line of ["*** Add File: a.ts", "*** Delete File: a.ts", "*** Move to: b.ts"]) {
			const w = contamination(`${line}\n`);
			expect(w).toMatch(/apply_patch sentinel/);
			expect(w).toMatch(/not valid in hashline/);
		}
	});

	it("still flags an indented Update File: because trimStart is the match point", () => {
		const w = contamination("    *** Update File: src/foo.ts\n");
		expect(w).toMatch(/apply_patch sentinel/);
	});

	it("does not treat a payload line that merely mentions Update File as a sentinel", () => {
		const parsed = parsePatch("[foo.ts#ABCD]\nSWAP 1.=1:\n+see *** Update File: in a comment\n");
		const w = parsed.warnings.join("\n");
		expect(w).not.toMatch(/apply_patch sentinel/);
	});
});

describe("unified-diff hunk headers are not hashline ops", () => {
	it("names @@ -1,3 +1,4 @@ as a unified-diff hunk header", () => {
		const w = contamination("@@ -1,3 +1,4 @@\n");
		expect(w).toMatch(/unified-diff hunk header/);
		expect(w).toMatch(/SWAP /);
	});

	it("names a bare @@ header without counts", () => {
		const w = contamination("@@ foo @@\n");
		expect(w).toMatch(/@@/);
		expect(w).toMatch(/not valid in hashline/);
		expect(w).toMatch(/SWAP /);
	});

	it("does not treat a payload `@@` after a verb as a hunk header", () => {
		const parsed = parsePatch("[foo.ts#ABCD]\nSWAP 1.=1:\n+const x = '@@ -1,1 +1,1 @@';\n");
		expect(parsed.warnings.join("\n")).not.toMatch(/unified-diff hunk header/);
	});
});

describe("DEL with a colon and a bare range without a verb are wiring mistakes", () => {
	it("tells the operator that DEL N.=M has no colon and no body", () => {
		const w = contamination("DEL 3.=5:\n+oops\n");
		expect(w).toMatch(/DEL /);
		expect(w).toMatch(/no colon and no body/);
	});

	it("tells the operator a lone line number needs a verb", () => {
		const w = contamination("12\n");
		expect(w).toMatch(/hunk headers need a verb/);
		expect(w).toMatch(/SWAP 12/);
		expect(w).toMatch(/DEL 12/);
	});

	it("tells the operator a bare 12-15 range needs SWAP or DEL", () => {
		const w = contamination("12-15\n");
		expect(w).toMatch(/bare range hunk header/);
		expect(w).toMatch(/SWAP 12/);
		expect(w).toMatch(/DEL 12/);
	});

	it("tells the operator a bare 12.=15 range needs SWAP or DEL", () => {
		const w = contamination("12.=15\n");
		expect(w).toMatch(/bare range hunk header/);
		expect(w).toMatch(/SWAP 12/);
	});
});
