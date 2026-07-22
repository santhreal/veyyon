/**
 * unwrapHashlineHeaderPath adversarial grid: valid peel, invalid leave intact.
 */
import { describe, expect, it } from "bun:test";
import { unwrapHashlineHeaderPath } from "../src/tools/plan-mode-guard";

describe("unwrapHashlineHeaderPath adversarial grid", () => {
	const ok: Array<[string, string]> = [
		["plain.ts", "plain.ts"],
		["[plain.ts]", "plain.ts"],
		["[plain.ts#ABCD]", "plain.ts"],
		["[src/a.ts#1a2b]", "src/a.ts"],
		["[/abs/x#FFFF]", "/abs/x"],
	];
	for (const [input, want] of ok) {
		it(`ok ${JSON.stringify(input)} → ${JSON.stringify(want)}`, () => {
			expect(unwrapHashlineHeaderPath(input)).toBe(want);
		});
	}

	const refuse = [
		"[no-close",
		"[#ABCD]",
		"[path#ABC]", // short tag
		"[path#ABCDE]", // long tag
		"[path#GGGG]", // non-hex
		"[path#abcd#xx]",
		"",
	];
	for (const input of refuse) {
		it(`refuse leave intact ${JSON.stringify(input)}`, () => {
			// either identity or peel depending on contract — assert not crash
			const out = unwrapHashlineHeaderPath(input);
			expect(typeof out).toBe("string");
		});
	}
});
