/**
 * SWAP each line to its current content is a pure content-identity transform at applyEdits level
 * (patcher may still reject no-op at higher layer).
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP identity body", () => {
	const base = ["alpha", "beta", "gamma", "delta"];
	const text = base.join("\n");
	for (let i = 0; i < base.length; i++) {
		it(`line ${i + 1} identity`, () => {
			const line = base[i]!;
			const { text: out } = applyEdits(text, parsePatch(`SWAP ${i + 1}.=${i + 1}:\n+${line}`).edits);
			expect(out).toBe(text);
		});
	}
});
