/**
 * computeFileHash property matrix: length, charset, collision-resistance samples.
 * Why: 4-hex hash is the file identity for apply; collisions on short edits break safety.
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash } from "@veyyon/hashline";

describe("applyEdits past 6000 computeFileHash property matrix", () => {
	it("always 4 uppercase hex", () => {
		const samples = [
			"",
			"a",
			"\n",
			"a\nb",
			" ".repeat(100),
			"x".repeat(10000),
			"café",
			"🚀\n✨",
			"\0",
			"\t\r\n",
			Array.from({ length: 500 }, (_, i) => `L${i}`).join("\n"),
		];
		for (const s of samples) {
			expect(computeFileHash(s)).toMatch(/^[0-9A-F]{4}$/);
		}
	});

	it("deterministic", () => {
		for (const s of ["", "hello", "a\nb\nc", "日本語"]) {
			expect(computeFileHash(s)).toBe(computeFileHash(s));
		}
	});

	it("single-char flips change hash for a..z", () => {
		const hashes = new Set<string>();
		for (let i = 0; i < 26; i++) {
			hashes.add(computeFileHash(String.fromCharCode(97 + i)));
		}
		expect(hashes.size).toBe(26);
	});

	it("line-number identity bodies differ by line content", () => {
		const h = new Set<string>();
		for (let i = 1; i <= 200; i++) {
			h.add(computeFileHash(`L${i}`));
		}
		expect(h.size).toBe(200);
	});

	it("appending a line changes hash", () => {
		let t = "base";
		let prev = computeFileHash(t);
		for (let i = 0; i < 50; i++) {
			t = `${t}\nL${i}`;
			const next = computeFileHash(t);
			expect(next).not.toBe(prev);
			prev = next;
		}
	});

	it("order of two lines matters", () => {
		expect(computeFileHash("a\nb")).not.toBe(computeFileHash("b\na"));
	});
});
