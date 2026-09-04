/**
 * Property-style matrices for buildCompactDiffPreview: counts, renumber, elision.
 */
import { describe, expect, it } from "bun:test";
import { buildCompactDiffPreview } from "../src/diff-preview";

describe("buildCompactDiffPreview counts and empty", () => {
	it("empty diff yields empty preview and zero counts", () => {
		expect(buildCompactDiffPreview("")).toEqual({
			preview: "",
			addedLines: 0,
			removedLines: 0,
		});
	});

	it("only removals count removed and leave empty or separator-free preview", () => {
		const p = buildCompactDiffPreview(["-1|a", "-2|b", "-3|c"].join("\n"));
		expect(p.addedLines).toBe(0);
		expect(p.removedLines).toBe(3);
		expect(p.preview).toBe("");
	});

	it("only context renumbers with zero offset", () => {
		const p = buildCompactDiffPreview([" 1|a", " 2|b", " 3|c"].join("\n"));
		expect(p).toEqual({
			preview: "1:a\n2:b\n3:c",
			addedLines: 0,
			removedLines: 0,
		});
	});

	it("unparsed lines pass through after flush", () => {
		const p = buildCompactDiffPreview([" 1|keep", "@@ junk @@", " 2|next"].join("\n"));
		expect(p.preview.split("\n")).toEqual(["1:keep", "@@ junk @@", "2:next"]);
	});
});

describe("buildCompactDiffPreview renumber after net add/remove", () => {
	it("net +2 shifts later context by +2", () => {
		const diff = [" 1|a", "+2|X", "+3|Y", " 2|b"].join("\n");
		const p = buildCompactDiffPreview(diff);
		expect(p.preview.split("\n")).toEqual(["1:a", "2:X", "3:Y", "4:b"]);
		expect(p.addedLines).toBe(2);
		expect(p.removedLines).toBe(0);
	});

	it("net -2 shifts later context by -2", () => {
		const diff = [" 1|a", "-2|gone1", "-3|gone2", " 4|b"].join("\n");
		const p = buildCompactDiffPreview(diff);
		expect(p.preview.split("\n")).toEqual(["1:a", "2:b"]);
		expect(p.removedLines).toBe(2);
	});

	it("mixed replace mid-file: remove 1 add 3 renumbers tail", () => {
		const diff = [" 1|h", "-2|old", "+2|n1", "+3|n2", "+4|n3", " 3|t"].join("\n");
		const p = buildCompactDiffPreview(diff);
		expect(p.preview.split("\n")).toEqual(["1:h", "2:n1", "3:n2", "4:n3", "5:t"]);
		expect(p.addedLines).toBe(3);
		expect(p.removedLines).toBe(1);
	});
});

describe("buildCompactDiffPreview added-run collapse matrix", () => {
	for (const edge of [1, 2, 3]) {
		it(`edgeLines=${edge}: run of length <= 2*edge+1 is not collapsed`, () => {
			const keep = edge * 2 + 1;
			const diff = Array.from({ length: keep }, (_, i) => `+${i + 1}|L${i}`).join("\n");
			const p = buildCompactDiffPreview(diff, { maxAddedRunContext: edge });
			expect(p.preview).not.toContain("…");
			expect(p.preview.split("\n")).toHaveLength(keep);
			expect(p.addedLines).toBe(keep);
		});

		it(`edgeLines=${edge}: run of length 2*edge+2 collapses to head+…+tail`, () => {
			const n = edge * 2 + 2;
			const diff = Array.from({ length: n }, (_, i) => `+${10 + i}|L${i}`).join("\n");
			const p = buildCompactDiffPreview(diff, { maxAddedRunContext: edge });
			const rows = p.preview.split("\n");
			expect(rows).toContain("…");
			expect(rows[0]).toBe(`10:L0`);
			expect(rows[edge - 1]).toBe(`${9 + edge}:L${edge - 1}`);
			expect(rows[edge]).toBe("…");
			expect(rows[edge + 1]).toBe(`${10 + n - edge}:L${n - edge}`);
			expect(rows[rows.length - 1]).toBe(`${9 + n}:L${n - 1}`);
			expect(p.addedLines).toBe(n);
		});
	}

	it("non-finite maxAddedRunContext falls back to default 2", () => {
		const diff = Array.from({ length: 7 }, (_, i) => `+${i + 1}|x${i}`).join("\n");
		const p = buildCompactDiffPreview(diff, { maxAddedRunContext: Number.NaN });
		// default edge 2 → collapse threshold 5, so 7 collapses
		expect(p.preview).toContain("…");
		expect(p.addedLines).toBe(7);
	});

	it("maxUnchangedRun alias drives the same collapse", () => {
		const diff = Array.from({ length: 7 }, (_, i) => `+${i + 1}|y${i}`).join("\n");
		const viaAlias = buildCompactDiffPreview(diff, { maxUnchangedRun: 1 });
		const viaPrimary = buildCompactDiffPreview(diff, { maxAddedRunContext: 1 });
		expect(viaAlias).toEqual(viaPrimary);
	});
});

describe("buildCompactDiffPreview separator hygiene", () => {
	it("does not stack multiple elision markers", () => {
		const p = buildCompactDiffPreview([" 1|a", "...", "…", "...", " 9|z"].join("\n"));
		const markers = p.preview.split("\n").filter(l => l === "…");
		expect(markers).toHaveLength(1);
	});

	it("drops leading separators", () => {
		const p = buildCompactDiffPreview(["…", " 1|a"].join("\n"));
		expect(p.preview).toBe("1:a");
	});

	it("trims trailing separators after removed-only tail", () => {
		const p = buildCompactDiffPreview([" 1|a", "-2|x", ""].join("\n"));
		expect(p.preview.endsWith("…") || p.preview.endsWith("")).toBe(true);
		expect(p.preview.startsWith("1:a")).toBe(true);
		expect(p.removedLines).toBe(1);
	});

	it("pipe-less numbered-looking lines are unparsed pass-through", () => {
		const p = buildCompactDiffPreview("+1nope\n 2|ok");
		expect(p.preview.split("\n")[0]).toBe("+1nope");
		expect(p.addedLines).toBe(0);
	});
});
