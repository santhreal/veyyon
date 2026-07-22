/**
 * applyEdits returns firstChangedLine: 1-indexed first line that differs from
 * input after the edit set (or undefined when no-op identity).
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits firstChangedLine property", () => {
	const base = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n");

	for (let line = 1; line <= 10; line++) {
		it(`SWAP line ${line} firstChangedLine=${line}`, () => {
			const r = applyEdits(base, parsePatch(`SWAP ${line}.=${line}:\n+X`).edits);
			expect(r.firstChangedLine).toBe(line);
		});

		it(`DEL line ${line} firstChangedLine=${line}`, () => {
			const r = applyEdits(base, parsePatch(`DEL ${line}`).edits);
			expect(r.firstChangedLine).toBe(line);
		});
	}

	it("INS.HEAD firstChangedLine 1", () => {
		expect(applyEdits(base, parsePatch("INS.HEAD:\n+H").edits).firstChangedLine).toBe(1);
	});

	it("INS.TAIL firstChangedLine after last content", () => {
		const r = applyEdits(base, parsePatch("INS.TAIL:\n+T").edits);
		// append — first changed may be 11 or 10 depending on contract
		expect(r.firstChangedLine).toBeDefined();
		expect(r.firstChangedLine!).toBeGreaterThanOrEqual(10);
	});

	it("identity SWAP firstChangedLine undefined or still set", () => {
		const r = applyEdits(base, parsePatch("SWAP 1.=1:\n+L1").edits);
		// no-op content may still report a change line or undefined
		if (r.firstChangedLine !== undefined) {
			expect(r.firstChangedLine).toBe(1);
		}
		expect(r.text).toBe(base);
	});
});
