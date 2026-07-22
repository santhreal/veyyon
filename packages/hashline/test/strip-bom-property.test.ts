import { describe, expect, it } from "bun:test";
import { stripBom } from "@veyyon/hashline";

/**
 * stripBom properties: BOM presence and text remainder.
 */

describe("stripBom property", () => {
	it("BOM-free strings return empty bom and same text", () => {
		const samples = ["", "a", "hello\n", "日本語", "\n\n", "a\0b"];
		for (const s of samples) {
			const r = stripBom(s);
			expect(r.bom).toBe("");
			expect(r.text).toBe(s);
		}
	});

	it("leading FEFF is stripped once", () => {
		const r = stripBom("\uFEFFhello");
		expect(r.bom).toBe("\uFEFF");
		expect(r.text).toBe("hello");
		const r2 = stripBom(r.text);
		expect(r2.bom).toBe("");
		expect(r2.text).toBe("hello");
	});

	it("interior FEFF is not treated as BOM", () => {
		const r = stripBom("a\uFEFFb");
		expect(r.bom).toBe("");
		expect(r.text).toBe("a\uFEFFb");
	});

	it("BOM-only string leaves empty text", () => {
		const r = stripBom("\uFEFF");
		expect(r.bom).toBe("\uFEFF");
		expect(r.text).toBe("");
	});
});
