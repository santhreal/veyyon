import { describe, expect, it } from "bun:test";
import { computeFileHash } from "@veyyon/hashline";

/**
 * computeFileHash stability/sensitivity over many inputs.
 */

describe("computeFileHash property-style", () => {
	it("identical strings always share the same 4-hex hash", () => {
		for (let i = 0; i < 200; i++) {
			const body = `line-${i}\nbody-${i * 3}\n`;
			const a = computeFileHash(body);
			const b = computeFileHash(body);
			expect(a).toMatch(/^[0-9A-Fa-f]{4}$/);
			expect(a).toBe(b);
		}
	});

	it("single-character flips change the hash for distinct bodies", () => {
		const base = "abcdefghijklmnopqrstuvwxyz\n";
		const hashes = new Set<string>();
		hashes.add(computeFileHash(base));
		for (let i = 0; i < base.length - 1; i++) {
			if (base[i] === "\n") continue;
			const flipped = base.slice(0, i) + (base[i] === "a" ? "b" : "a") + base.slice(i + 1);
			hashes.add(computeFileHash(flipped));
		}
		// Not every flip is guaranteed unique under a 16-bit space, but most should differ from base.
		expect(hashes.size).toBeGreaterThan(10);
	});

	it("empty and near-empty inputs are stable", () => {
		expect(computeFileHash("")).toBe(computeFileHash(""));
		expect(computeFileHash("\n")).toBe(computeFileHash("\n"));
		expect(computeFileHash("")).not.toBe(computeFileHash("\n"));
	});

	it("length-4 hex for multi-kilobyte bodies", () => {
		const big = `${"x".repeat(50_000)}\n`;
		const h = computeFileHash(big);
		expect(h).toMatch(/^[0-9A-Fa-f]{4}$/);
		expect(computeFileHash(`${big}y`)).not.toBe(h);
	});
});
