/**
 * A pure insertion may anchor a line a producer clipped at its column cap. Nothing else may.
 *
 * WHAT THIS CLOSES. A read applies a per-line column cap, so a very wide line reaches
 * the model as a prefix plus `…`. Such a line is deliberately withheld from
 * `Snapshot.seenLines`, and the seen-line guard then refused EVERY edit anchored on it
 * — including `INS.PRE`, which does not touch the anchored line at all. Observed live
 * on a file whose rows are a few kilobytes each: adding one line before a wide row was
 * refused, and the remedy the message named was to pull that whole row into context
 * with `:raw` first. An insertion reads its anchor as a POSITION, the position is what
 * the content tag certifies, and the bytes survive identical, so there was nothing for
 * the refusal to protect.
 *
 * THE CLASS, not the incident. Two anchor states and every edit form, swept rather
 * than sampled:
 *
 *   - DISPLAYED BUT CLIPPED. The model saw the line number and a leading prefix. A
 *     pure insertion is allowed. Every form that replaces or deletes those bytes
 *     (`SWAP`, `DEL`, and the `.BLK` variants) is still refused, because those rewrite
 *     bytes nobody read. That is the edge case, and it does not move.
 *   - NEVER RENDERED. An elided body, a folded summary row, a line outside the read
 *     range. Refused for every form INCLUDING an insertion: without even a prefix
 *     there is nothing to identify, so the position itself is a guess.
 *
 * Every refusal is asserted to leave the file byte-identical, because a guard that
 * rejects after a partial write is worse than no guard.
 *
 * WHAT IT DOES NOT CATCH. Whether a producer reports its clipped set at all — that is
 * the read tool's contract and is covered where the read tool is tested. It says
 * nothing about the column cap's value, and it does not decide whether an insertion
 * beside a clipped line is what the author MEANT; a position can be identified from a
 * prefix and still be the wrong position.
 */
import { describe, expect, it } from "bun:test";
import type { BlockResolver, Edit } from "@veyyon/hashline";
import {
	collectRewrittenAnchorLines,
	editRewritesItsAnchor,
	InMemoryFilesystem,
	InMemorySnapshotStore,
	Patch,
	Patcher,
} from "@veyyon/hashline";

const PATH = "wide.md";
const WIDE = "W".repeat(4000);
const CONTENT = `head\n${WIDE}\ntail\nlast\n`;
/** The wide row. */
const CLIPPED_LINE = 2;
/** A line the read never rendered at all. */
const UNRENDERED_LINE = 4;
/**
 * A read that showed lines 1-3, with line 2 cut at the column cap. Line 4 was never
 * rendered. This is exactly the state a column-capped ranged read leaves behind.
 *
 * A block resolver is supplied because block resolution runs BEFORE the seen-line
 * guard: without one the `.BLK` forms fail on "no block resolver configured" and never
 * reach the guard at all, which would leave three of the seven forms unexercised. The
 * resolver is the one seam here that is legitimately stubbed — it answers "which lines
 * is this block", and what is under test is what the guard does with the answer.
 */
function afterAClippedRead(): { fs: InMemoryFilesystem; patcher: Patcher; tag: string } {
	const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
	const snapshots = new InMemorySnapshotStore();
	const tag = snapshots.record(PATH, CONTENT, [1, 3]);
	snapshots.recordClippedLines(PATH, tag, [CLIPPED_LINE]);
	// A two-line span: the block layer rejects a single-line resolution as "a bare
	// statement, not the opening line of a multi-line construct", which would stop
	// the `.BLK` forms short of the guard again.
	const blockResolver: BlockResolver = request => ({ start: request.line, end: request.line + 1 });
	return { fs, patcher: new Patcher({ fs, snapshots, blockResolver }), tag };
}

/** Every edit form, and whether it rewrites the bytes of the line it anchors on. */
const FORMS = [
	{ form: "INS.PRE", body: (line: number) => `INS.PRE ${line}:\n+added`, rewritesItsAnchor: false },
	{ form: "INS.POST", body: (line: number) => `INS.POST ${line}:\n+added`, rewritesItsAnchor: false },
	{ form: "SWAP", body: (line: number) => `SWAP ${line}.=${line}:\n+replaced`, rewritesItsAnchor: true },
	{ form: "DEL", body: (line: number) => `DEL ${line}`, rewritesItsAnchor: true },
	{ form: "SWAP.BLK", body: (line: number) => `SWAP.BLK ${line}:\n+replaced`, rewritesItsAnchor: true },
	{ form: "DEL.BLK", body: (line: number) => `DEL.BLK ${line}`, rewritesItsAnchor: true },
	{ form: "INS.BLK.POST", body: (line: number) => `INS.BLK.POST ${line}:\n+added`, rewritesItsAnchor: true },
] as const;

describe("an insertion may anchor a line too wide to print", () => {
	it("sweeps every edit form the patch language has", () => {
		// The corpus the cases below are generated from. Pinned by exact equality so
		// a new form cannot be added to the language and silently skipped here.
		expect(FORMS.map(f => f.form)).toEqual([
			"INS.PRE",
			"INS.POST",
			"SWAP",
			"DEL",
			"SWAP.BLK",
			"DEL.BLK",
			"INS.BLK.POST",
		]);
		// And it has to contain both kinds, or one column of the matrix is empty.
		expect(FORMS.some(f => f.rewritesItsAnchor)).toBe(true);
		expect(FORMS.some(f => !f.rewritesItsAnchor)).toBe(true);
	});

	/**
	 * The classifier answers for every arm of the Edit union, asked directly.
	 *
	 * Driving it only through patches leaves one arm masked: a `SWAP` lowers to a
	 * replacement insert AND a delete on the same anchor, so the delete alone
	 * already marks the line rewritten and mis-classifying the insert changes
	 * nothing observable. A lowering that emitted a replacement insert without its
	 * delete would then be waved through. Asked here directly, so the arm is
	 * pinned rather than shadowed.
	 */
	it("classifies every arm of the edit union, including a lone replacement insert", () => {
		const anchor = { line: 7, text: undefined };
		const insertAt = (mode?: "replacement"): Edit => ({
			kind: "insert",
			cursor: { kind: "before_anchor", anchor },
			text: "x",
			lineNum: 1,
			index: 0,
			mode,
		});

		expect(editRewritesItsAnchor(insertAt())).toBe(false);
		expect(editRewritesItsAnchor(insertAt("replacement"))).toBe(true);
		expect(editRewritesItsAnchor({ kind: "delete", anchor, lineNum: 1, index: 0 })).toBe(true);
		expect(editRewritesItsAnchor({ kind: "block", anchor, payloads: ["x"], lineNum: 1, index: 0 })).toBe(true);
		expect(
			editRewritesItsAnchor({ kind: "block", anchor, payloads: ["x"], mode: "insert_after", lineNum: 1, index: 0 }),
		).toBe(true);

		// And the set query agrees: a lone replacement insert marks its own anchor.
		expect([...collectRewrittenAnchorLines([insertAt("replacement")])]).toEqual([7]);
		expect([...collectRewrittenAnchorLines([insertAt()])]).toEqual([]);
	});

	describe("anchored on a line displayed but clipped", () => {
		for (const { form, body, rewritesItsAnchor } of FORMS) {
			if (rewritesItsAnchor) {
				it(`refuses ${form}, which rewrites bytes nobody read`, async () => {
					const { fs, patcher, tag } = afterAClippedRead();
					await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\n${body(CLIPPED_LINE)}`))).rejects.toThrow(
						/never displayed \(it showed/,
					);
					expect(fs.get(PATH)).toBe(CONTENT);
				});
				continue;
			}
			it(`applies ${form}, which uses the anchor as a position`, async () => {
				const { fs, patcher, tag } = afterAClippedRead();
				const result = await patcher.apply(Patch.parse(`[${PATH}#${tag}]\n${body(CLIPPED_LINE)}`));
				expect(result.sections[0]?.op).toBe("update");
				const after = fs.get(PATH) ?? "";
				// The clipped row survives BYTE-IDENTICAL, which is the whole argument
				// for allowing this: not that the edit is small, that it is not a write
				// to the line it anchors on.
				expect(after).toContain(WIDE);
				expect(after.split("\n").filter(line => line === WIDE)).toHaveLength(1);
				expect(after).toContain("added");
				expect(after.split("\n")).toHaveLength(CONTENT.split("\n").length + 1);
			});
		}

		it("puts the inserted line on the side the form names", async () => {
			// A position the model can identify from a prefix is only useful if the
			// tool lands on the side it was told to.
			const before = afterAClippedRead();
			await before.patcher.apply(Patch.parse(`[${PATH}#${before.tag}]\nINS.PRE ${CLIPPED_LINE}:\n+added`));
			expect((before.fs.get(PATH) ?? "").split("\n").slice(0, 3)).toEqual(["head", "added", WIDE]);

			const after = afterAClippedRead();
			await after.patcher.apply(Patch.parse(`[${PATH}#${after.tag}]\nINS.POST ${CLIPPED_LINE}:\n+added`));
			expect((after.fs.get(PATH) ?? "").split("\n").slice(0, 3)).toEqual(["head", WIDE, "added"]);
		});
	});

	describe("anchored on a line never rendered", () => {
		for (const { form, body } of FORMS) {
			it(`refuses ${form}, because not even a prefix was shown`, async () => {
				const { fs, patcher, tag } = afterAClippedRead();
				await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\n${body(UNRENDERED_LINE)}`))).rejects.toThrow(
					/never displayed \(it showed/,
				);
				expect(fs.get(PATH)).toBe(CONTENT);
			});
		}
	});

	it("keeps refusing an insertion when the read recorded no clipped line at all", async () => {
		// The permission comes from the producer reporting what it clipped, not from
		// the op being an insertion. A read that showed lines 1-3 and reported
		// nothing clipped grants nothing extra on line 2.
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const tag = snapshots.record(PATH, CONTENT, [1, 3]);
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[${PATH}#${tag}]\nINS.PRE ${CLIPPED_LINE}:\n+added`))).rejects.toThrow(
			/never displayed \(it showed/,
		);
		expect(fs.get(PATH)).toBe(CONTENT);
	});

	it("refuses a patch that mixes an allowed insertion with a rewrite of the same line", async () => {
		// The exemption is per EDIT, and a section carrying both must not be waved
		// through on the strength of its harmless half.
		const { fs, patcher, tag } = afterAClippedRead();
		const patch = `[${PATH}#${tag}]\nINS.PRE ${CLIPPED_LINE}:\n+added\nSWAP ${CLIPPED_LINE}.=${CLIPPED_LINE}:\n+replaced`;

		await expect(patcher.apply(Patch.parse(patch))).rejects.toThrow(/never displayed \(it showed/);
		expect(fs.get(PATH)).toBe(CONTENT);
	});

	it("still refuses an insertion beside a clipped line under a different tag's provenance", async () => {
		// Clipped lines belong to the snapshot they were recorded against. A later
		// read of DIFFERENT content must not inherit the earlier permission.
		const fs = new InMemoryFilesystem([[PATH, CONTENT]]);
		const snapshots = new InMemorySnapshotStore();
		const stale = snapshots.record(PATH, CONTENT, [1, 3]);
		snapshots.recordClippedLines(PATH, stale, [CLIPPED_LINE]);
		const changed = `${CONTENT}extra\n`;
		fs.set(PATH, changed);
		const fresh = snapshots.record(PATH, changed, [1, 3]);
		expect(fresh).not.toBe(stale);
		const patcher = new Patcher({ fs, snapshots });

		await expect(patcher.apply(Patch.parse(`[${PATH}#${fresh}]\nINS.PRE ${CLIPPED_LINE}:\n+added`))).rejects.toThrow(
			/never displayed \(it showed/,
		);
		expect(fs.get(PATH)).toBe(changed);
	});
});
