/**
 * Unicode opaque lines through DEL/SWAP/INS/HEAD/TAIL exact codepoints.
 * Why: multi-byte bodies must never be re-encoded or split.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, computeFileHash, parsePatch } from "@veyyon/hashline";

const samples = [
	"café",
	"日本語",
	"🚀✨",
	"Здравствуй",
	"مرحبا",
	"한글",
	"Ångström",
	"naïve",
	"🙂‍↔️",
	"a\u0301",
	"𐐷",
	"👨‍👩‍👧‍👦",
	"हिन्दी",
	"Ελληνικά",
	"ไทย",
];

describe("applyEdits past 6000 unicode opaque ops grid", () => {
	it("identity SWAP all preserves hash", () => {
		const base = samples.join("\n");
		const hunks = samples.map((s, i) => `SWAP ${i + 1}.=${i + 1}:\n+${s}`).join("\n");
		const { text } = applyEdits(base, parsePatch(hunks).edits);
		expect(text).toBe(base);
		expect(computeFileHash(text)).toBe(computeFileHash(base));
	});

	for (let i = 0; i < samples.length; i++) {
		it(`DEL line ${i + 1} keeps others`, () => {
			const base = samples.join("\n");
			const out = applyEdits(base, parsePatch(`DEL ${i + 1}`).edits).text;
			expect(out === "" ? [] : out.split("\n")).toEqual(samples.filter((_, j) => j !== i));
		});

		it(`SWAP line ${i + 1} to ZWJ family`, () => {
			const base = samples.join("\n");
			const out = applyEdits(base, parsePatch(`SWAP ${i + 1}.=${i + 1}:\n+👨‍👩‍👧‍👦`).edits)
				.text.split("\n");
			expect(out[i]).toBe("👨‍👩‍👧‍👦");
		});
	}

	it("HEAD all unicode samples prefix", () => {
		const base = "plain";
		const body = samples.map((s) => `+${s}`).join("\n");
		const out = applyEdits(base, parsePatch(`INS.HEAD:\n${body}`).edits).text.split("\n");
		expect(out).toEqual([...samples, "plain"]);
	});

	it("TAIL all unicode samples suffix", () => {
		const base = "plain";
		const body = samples.map((s) => `+${s}`).join("\n");
		const out = applyEdits(base, parsePatch(`INS.TAIL:\n${body}`).edits).text.split("\n");
		expect(out).toEqual(["plain", ...samples]);
	});
});
