import { describe, expect, it } from "bun:test";
import { applyEdits, HL_RANGE_SEP, parsePatch, resolveBlockEdits } from "@veyyon/hashline";
import { PATCH_OPERATIONS } from "../src/operations";
import type { BlockTarget } from "../src/tokenizer";

/**
 * WHY: `x\ny\n` reads as `1:x 2:y 3:` and the read prompt states that line 3
 * (the trailing-newline phantom) is the anchor to insert after to append at
 * end of file. `INS.POST 3:` instead produced `x\ny\n\nz`: the rebuild loop
 * emitted the "" sentinel as a real empty line and left the new last line
 * unterminated. Same class: any hunk operation that can address the phantom
 * line, in either direction, must produce a newline-terminated file whose
 * content lines are the intended ones, and the append spellings (`INS.POST
 * <phantom>`, `INS.TAIL`) must produce identical bytes.
 *
 * Closes the class by sweeping every operation in `PATCH_OPERATIONS` at run
 * time: a new operation fails the sweep until a decision is recorded below.
 * Block ops resolve through a resolver that finds no block on the phantom
 * line, which is the only resolution a blank line can have.
 *
 * Does not catch: an applier that writes the right bytes but a wrong
 * `firstChangedLine` for the appended row (asserted for the two append
 * spellings only), or a host that re-terminates the file after apply and so
 * masks the missing newline (the hashline layer is the subject here).
 */

type Kind = BlockTarget["kind"];

/** How a kind addresses the phantom line of a 2-line newline-terminated file. */
type Expectation = { outcome: "text"; text: string } | { outcome: "refused" } | { outcome: "file-op" };

const SRC = "x\ny\n";
const PHANTOM = 3;
const APPENDED = "x\ny\nz\n";

const EXPECTED: Record<Kind, Expectation> = {
	replace: { outcome: "text", text: APPENDED },
	block: { outcome: "refused" },
	delete: { outcome: "text", text: SRC },
	delete_block: { outcome: "refused" },
	insert_before: { outcome: "text", text: APPENDED },
	insert_after: { outcome: "text", text: APPENDED },
	insert_after_block: { outcome: "text", text: APPENDED },
	bof: { outcome: "text", text: "z\nx\ny\n" },
	eof: { outcome: "text", text: APPENDED },
	rem: { outcome: "file-op" },
	move: { outcome: "file-op" },
};

function hunkFor(kind: Kind, body: readonly string[] = ["z"]): string {
	const spec = PATCH_OPERATIONS[kind];
	const arg =
		kind === "replace"
			? ` ${PHANTOM}${HL_RANGE_SEP}${PHANTOM}`
			: kind === "move"
				? " moved.txt"
				: spec.cursorKind === "bof" || spec.cursorKind === "eof" || spec.isFileOp
					? ""
					: ` ${PHANTOM}`;
	const header = `${spec.keyword}${arg}${spec.allowColon ? ":" : ""}`;
	return spec.takesBody ? `${header}\n${body.map(row => `+${row}`).join("\n")}` : header;
}

function applyHunk(hunk: string, text = SRC) {
	const parsed = parsePatch(hunk);
	const warnings: string[] = [];
	const resolved = resolveBlockEdits(parsed.edits, text, "a.txt", () => null, {
		onWarning: message => warnings.push(message),
	});
	return { ...applyEdits(text, resolved), warnings };
}

describe("a plain insert after the trailing phantom line appends to the file", () => {
	it("records a decision for every patch operation", () => {
		expect(Object.keys(EXPECTED).sort()).toEqual(Object.keys(PATCH_OPERATIONS).sort());
	});

	for (const kind of Object.keys(PATCH_OPERATIONS) as Kind[]) {
		const expected = EXPECTED[kind];
		const hunk = hunkFor(kind);
		it(`${kind} (${hunk.split("\n")[0]}) → ${expected.outcome}`, () => {
			if (expected.outcome === "file-op") {
				const parsed = parsePatch(hunk);
				expect(parsed.edits).toEqual([]);
				expect<string | undefined>(parsed.fileOp?.kind).toBe(kind);
				return;
			}
			if (expected.outcome === "refused") {
				expect(() => applyHunk(hunk)).toThrow();
				return;
			}
			expect(applyHunk(hunk).text).toBe(expected.text);
		});
	}

	it("INS.POST <phantom> and INS.TAIL produce identical bytes and the same first changed line", () => {
		const post = applyHunk(hunkFor("insert_after", ["z", "w"]));
		const tail = applyHunk(hunkFor("eof", ["z", "w"]));
		expect(post.text).toBe("x\ny\nz\nw\n");
		expect(post.text).toBe(tail.text);
		expect(post.firstChangedLine).toBe(PHANTOM);
		expect(post.firstChangedLine).toBe(tail.firstChangedLine);
	});

	it("keeps authored order when INS.POST <phantom> and INS.TAIL appear in one patch", () => {
		const first = applyHunk(`${hunkFor("insert_after", ["a"])}\n${hunkFor("eof", ["b"])}`);
		expect(first.text).toBe("x\ny\na\nb\n");
		const second = applyHunk(`${hunkFor("eof", ["b"])}\n${hunkFor("insert_after", ["a"])}`);
		expect(second.text).toBe("x\ny\nb\na\n");
	});

	it("INS.POST on the last content line of a file with no trailing newline stays unterminated", () => {
		const out = applyHunk("INS.POST 2:\n+z", "x\ny");
		expect(out.text).toBe("x\ny\nz");
	});

	it("INS.POST on the last content line of a newline-terminated file lands before the phantom", () => {
		expect(applyHunk("INS.POST 2:\n+z").text).toBe(APPENDED);
	});

	it("a phantom-line INS.POST body that is itself blank appends one empty line", () => {
		expect(applyHunk("INS.POST 3:\n+").text).toBe("x\ny\n\n");
	});
});
