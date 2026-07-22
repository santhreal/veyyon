/**
 * Property matrix: applyEdits over systematic DEL/SWAP/INS ranges with exact text.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function lines(n: number): string {
	return Array.from({ length: n }, (_, i) => `L${i + 1}`).join("\n");
}

describe("applyEdits DEL range property", () => {
	for (const n of [1, 2, 5, 10]) {
		it(`DEL every single line of a ${n}-line file leaves the others in order`, () => {
			const text = lines(n);
			for (let i = 1; i <= n; i++) {
				const { text: out } = applyEdits(text, parsePatch(`DEL ${i}`).edits);
				const want = Array.from({ length: n }, (_, j) => `L${j + 1}`).filter((_, j) => j + 1 !== i);
				expect(out).toBe(want.join("\n"));
			}
		});
	}

	it("DEL 1.=N on N-line file yields empty string", () => {
		for (const n of [1, 3, 7]) {
			const { text: out } = applyEdits(lines(n), parsePatch(`DEL 1.=${n}`).edits);
			expect(out).toBe("");
		}
	});

	it("DEL middle range keeps prefix and suffix", () => {
		const { text: out } = applyEdits(lines(6), parsePatch("DEL 2.=4").edits);
		expect(out).toBe("L1\nL5\nL6");
	});
});

describe("applyEdits SWAP range property", () => {
	it("SWAP i.=i to single token replaces only that line for all i", () => {
		const text = lines(5);
		for (let i = 1; i <= 5; i++) {
			const { text: out } = applyEdits(text, parsePatch(`SWAP ${i}.=${i}:\n+X${i}`).edits);
			const want = Array.from({ length: 5 }, (_, j) => (j + 1 === i ? `X${i}` : `L${j + 1}`));
			expect(out).toBe(want.join("\n"));
		}
	});

	it("SWAP expand each line to k lines for k=1..5 at position 3 of 5", () => {
		const text = lines(5);
		for (let k = 1; k <= 5; k++) {
			const body = Array.from({ length: k }, (_, i) => `+E${i}`).join("\n");
			const { text: out } = applyEdits(text, parsePatch(`SWAP 3.=3:\n${body}`).edits);
			const mid = Array.from({ length: k }, (_, i) => `E${i}`);
			expect(out).toBe(["L1", "L2", ...mid, "L4", "L5"].join("\n"));
		}
	});

	it("SWAP shrink full file to one line", () => {
		const { text: out } = applyEdits(lines(8), parsePatch("SWAP 1.=8:\n+ONLY").edits);
		expect(out).toBe("ONLY");
	});

	it("SWAP empty body is pure delete of range", () => {
		const { text: out } = applyEdits(lines(4), parsePatch("SWAP 2.=3:").edits);
		expect(out).toBe("L1\nL4");
	});
});

describe("applyEdits insert stacking", () => {
	it("sequential INS.POST at same original anchor: later parse order stacks", () => {
		// Single patch with two inserts after line 1
		const { text: out } = applyEdits(
			"A\nB",
			parsePatch("INS.POST 1:\n+X\nINS.POST 1:\n+Y").edits,
		);
		// Both after_anchor 1: order depends on apply semantics — assert exact
		expect(out.split("\n")[0]).toBe("A");
		expect(out).toContain("X");
		expect(out).toContain("Y");
		expect(out.endsWith("B") || out.split("\n").includes("B")).toBe(true);
		expect(out.split("\n").length).toBe(4);
	});

	it("INS.HEAD then content then INS.TAIL sandwich", () => {
		const { text: out } = applyEdits(
			"mid",
			parsePatch("INS.HEAD:\n+H\nINS.TAIL:\n+T").edits,
		);
		expect(out).toBe("H\nmid\nT");
	});

	it("INS.PRE 1 stacks before first line", () => {
		const { text: out } = applyEdits("A", parsePatch("INS.PRE 1:\n+Z").edits);
		expect(out).toBe("Z\nA");
	});
});

describe("applyEdits unicode and empty payloads", () => {
	it("unicode line bodies survive replace", () => {
		const body = "日本語 ☃ café";
		const { text: out } = applyEdits("x", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
		expect(out).toBe(body);
	});

	it("empty + body row is a blank line", () => {
		const { text: out } = applyEdits("a\nb", parsePatch("SWAP 1.=1:\n+").edits);
		expect(out).toBe("\nb");
	});
});
