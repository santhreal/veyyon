/**
 * CJK and fullwidth punctuation body content is opaque.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits CJK fullwidth body", () => {
	const bodies = [
		"你好世界",
		"日本語テスト",
		"한글",
		"全角：ＡＢＣ",
		"「引用」",
		"【括号】",
	];
	for (const body of bodies) {
		it(body, () => {
			const { text } = applyEdits("old", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
			expect(text).toBe(body);
		});
	}
});
