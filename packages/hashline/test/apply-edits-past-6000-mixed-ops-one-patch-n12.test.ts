/**
 * One patch: DEL odds + SWAP evens + HEAD insert on n=12.
 * Why: mixed multi-hunk concurrent original indices must compose predictably.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 mixed ops one patch n12", () => {
	const n = 12;
	const lines = Array.from({ length: n }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");

	it("DEL all odds + SWAP all evens + HEAD in one patch", () => {
		const dels = Array.from({ length: n / 2 }, (_, i) => `DEL ${i * 2 + 1}`);
		const swaps = Array.from(
			{ length: n / 2 },
			(_, i) => `SWAP ${i * 2 + 2}.=${i * 2 + 2}:\n+E${i * 2 + 2}`,
		);
		const patch = [`INS.HEAD:\n+H`, ...dels, ...swaps].join("\n");
		const { text } = applyEdits(base, parsePatch(patch).edits);
		// Concurrent original indices: DEL odds and SWAP evens on original,
		// HEAD prepends. Remaining lines are the swapped evens, with H first.
		const out = text.split("\n");
		expect(out[0]).toBe("H");
		// After deleting odds and swapping evens, only even lines remain as E2,E4,...
		const rest = out.slice(1);
		expect(rest).toEqual(Array.from({ length: n / 2 }, (_, i) => `E${(i + 1) * 2}`));
	});

	it("INS.TAIL + multi SWAP first half", () => {
		const swaps = Array.from(
			{ length: 6 },
			(_, i) => `SWAP ${i + 1}.=${i + 1}:\n+S${i + 1}`,
		);
		const patch = [`INS.TAIL:\n+T`, ...swaps].join("\n");
		const { text } = applyEdits(base, parsePatch(patch).edits);
		const out = text.split("\n");
		expect(out.slice(0, 6)).toEqual(["S1", "S2", "S3", "S4", "S5", "S6"]);
		expect(out.slice(6, 12)).toEqual(lines.slice(6));
		expect(out[12]).toBe("T");
	});
});
