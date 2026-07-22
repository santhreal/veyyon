/**
 * Trailing-newline / phantom-line addressing: split("\n") yields a trailing
 * empty sentinel that is addressable for inserts but not real content for DEL.
 * Exact shapes lock the phantom contract used by read/display/apply lockstep.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits trailing newline phantom matrix", () => {
	const cases: Array<{ src: string; patch: string; want: string; label: string }> = [
		{ label: "DEL1 no trailing", src: "a\nb", patch: "DEL 1", want: "b" },
		{ label: "DEL1 with trailing", src: "a\nb\n", patch: "DEL 1", want: "b\n" },
		{ label: "DEL2 no trailing", src: "a\nb", patch: "DEL 2", want: "a" },
		{ label: "DEL2 with trailing keeps phantom", src: "a\nb\n", patch: "DEL 2", want: "a\n" },
		{ label: "DEL1 single line trailing", src: "a\n", patch: "DEL 1", want: "" },
		{ label: "DEL1 empty-looking double nl", src: "a\n\n", patch: "DEL 1", want: "\n" },
		{ label: "DEL2 of double nl", src: "a\n\n", patch: "DEL 2", want: "a\n" },
		{ label: "only newline DEL1", src: "\n", patch: "DEL 1", want: "" },
		{ label: "empty INS.HEAD", src: "", patch: "INS.HEAD:\n+x", want: "x" },
		{ label: "empty INS.TAIL", src: "", patch: "INS.TAIL:\n+x", want: "x" },
		{ label: "trailing INS.POST last concrete", src: "a\nb\n", patch: "INS.POST 2:\n+x", want: "a\nb\nx\n" },
		{ label: "no trailing INS.POST last", src: "a\nb", patch: "INS.POST 2:\n+x", want: "a\nb\nx" },
		{ label: "trailing SWAP last concrete", src: "a\nb\n", patch: "SWAP 2.=2:\n+B", want: "a\nB\n" },
		{ label: "no trailing SWAP last", src: "a\nb", patch: "SWAP 2.=2:\n+B", want: "a\nB" },
		{ label: "INS.HEAD on trailing", src: "a\n", patch: "INS.HEAD:\n+H", want: "H\na\n" },
		// INS.TAIL on newline-terminated file: T lands before the trailing phantom,
		// so the file stays newline-terminated ("a\nT\n").
		{ label: "INS.TAIL on trailing", src: "a\n", patch: "INS.TAIL:\n+T", want: "a\nT\n" },
	];

	for (const c of cases) {
		it(c.label, () => {
			const { text } = applyEdits(c.src, parsePatch(c.patch).edits);
			expect(text).toBe(c.want);
		});
	}

	it("DEL phantom line 3 on a\\nb\\n is dropped (no throw, no content change on phantom-only)", () => {
		// Phantom at line 3 is filtered from delete set; file keeps concrete lines.
		const { text } = applyEdits("a\nb\n", parsePatch("DEL 3").edits);
		expect(text).toBe("a\nb\n");
	});
});
