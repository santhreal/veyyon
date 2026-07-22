/**
 * computeFileHash stability: same normalized text → same tag; adversarial near-misses differ.
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash, HL_FILE_HASH_LENGTH } from "@veyyon/hashline";

describe("computeFileHash stability matrix", () => {
	const samples = [
		"",
		"\n",
		"a",
		"a\n",
		"a\nb",
		"a\nb\n",
		"a  \nb", // trailing spaces stripped before hash
		"a\tb",
		"日本語",
		"a".repeat(10_000),
		Array.from({ length: 200 }, (_, i) => `L${i}`).join("\n"),
	];

	it("is pure: repeated calls on same text yield identical tags", () => {
		for (const s of samples) {
			const a = computeFileHash(s);
			const b = computeFileHash(s);
			expect(a).toBe(b);
			expect(a).toHaveLength(HL_FILE_HASH_LENGTH);
		}
	});

	it("trailing spaces/tabs/CR do not change hash vs trimmed form", () => {
		expect(computeFileHash("x  \n")).toBe(computeFileHash("x\n"));
		expect(computeFileHash("x\t\n")).toBe(computeFileHash("x\n"));
		expect(computeFileHash("x\r\n")).toBe(computeFileHash("x\n"));
	});

	it("near-miss strings produce different tags when content differs", () => {
		const pairs: Array<[string, string]> = [
			["a", "b"],
			["a\n", "a"],
			["a\nb", "a\nc"],
			["ab", "a b"],
			["", " "],
			["\n", "\n\n"],
		];
		for (const [x, y] of pairs) {
			// Only assert difference when normalizeFileHashText still differs
			const hx = computeFileHash(x);
			const hy = computeFileHash(y);
			if (x.replace(/[ \t\r]+(?=\n|$)/g, "") !== y.replace(/[ \t\r]+(?=\n|$)/g, "")) {
				expect(hx).not.toBe(hy);
			}
		}
	});

	it("always uppercase hex", () => {
		for (const s of samples) {
			expect(computeFileHash(s)).toMatch(/^[0-9A-F]{4}$/);
		}
	});
});
