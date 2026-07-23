/**
 * Patch.parse recovery headers: apply_patch noise and multi-section envelopes.
 */
import { describe, expect, it } from "bun:test";
import { containsRecognizableHashlineOperations, Patch } from "@veyyon/hashline";

describe("Patch.parse recovery and envelope noise", () => {
	it("Begin Patch envelope is stripped before first header", () => {
		const input = ["*** Begin Patch", "[a.ts#ABCD]", "DEL 1"].join("\n");
		const patch = Patch.parse(input);
		expect(patch.sections).toHaveLength(1);
		expect(patch.sections[0]?.path).toBe("a.ts");
	});

	it("leading blank lines and FEFF do not prevent parse", () => {
		const input = "\uFEFF\n\n\n[b.ts#1111]\nINS.HEAD:\n+z";
		const patch = Patch.parse(input);
		expect(patch.sections[0]?.path).toBe("b.ts");
	});

	it("three sections with mixed ops", () => {
		const input = [
			"[one.ts#AAAA]",
			"DEL 1",
			"[two.ts#BBBB]",
			"INS.TAIL:",
			"+t",
			"[three.ts#CCCC]",
			"SWAP 1.=1:",
			"+X",
		].join("\n");
		const patch = Patch.parse(input);
		expect(patch.sections.map(s => s.path)).toEqual(["one.ts", "two.ts", "three.ts"]);
		expect(patch.sections[0]!.edits.some(e => e.kind === "delete")).toBe(true);
		expect(patch.sections[1]!.edits.some(e => e.kind === "insert")).toBe(true);
		expect(patch.sections[2]!.edits.some(e => e.kind === "insert")).toBe(true);
	});

	it("Abort stops before later sections", () => {
		const input = ["[a.ts#ABCD]", "DEL 1", "*** Abort", "[b.ts#EF01]", "DEL 2"].join("\n");
		expect(Patch.parse(input).sections.map(s => s.path)).toEqual(["a.ts"]);
	});

	it("fallback path option only when ops present without header", () => {
		expect(containsRecognizableHashlineOperations("DEL 3")).toBe(true);
		const patch = Patch.parse("DEL 3", { path: "fallback.ts" });
		expect(patch.sections[0]?.path).toBe("fallback.ts");
	});

	it("prose without ops does not use fallback path injection", () => {
		expect(() => Patch.parse("just some text", { path: "f.ts" })).toThrow(/must begin with/);
	});
});
