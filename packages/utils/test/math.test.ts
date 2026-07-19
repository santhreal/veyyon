import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { clamp, clamp01 } from "../src/math";

describe("clamp", () => {
	it("returns the value when it is inside the range", () => {
		expect(clamp(5, 0, 10)).toBe(5);
		expect(clamp(0, 0, 10)).toBe(0);
		expect(clamp(10, 0, 10)).toBe(10);
	});

	it("clamps to the bounds when the value is outside", () => {
		expect(clamp(-3, 0, 10)).toBe(0);
		expect(clamp(42, 0, 10)).toBe(10);
		expect(clamp(-1, -5, -2)).toBe(-2);
		expect(clamp(-9, -5, -2)).toBe(-5);
	});

	it("maps non-finite inputs to the low bound", () => {
		expect(clamp(Number.NaN, 2, 8)).toBe(2);
		expect(clamp(Number.POSITIVE_INFINITY, 2, 8)).toBe(2);
		expect(clamp(Number.NEGATIVE_INFINITY, 2, 8)).toBe(2);
	});
});

describe("clamp01", () => {
	it("passes through values already in [0, 1]", () => {
		expect(clamp01(0)).toBe(0);
		expect(clamp01(1)).toBe(1);
		expect(clamp01(0.42)).toBe(0.42);
	});

	it("clamps values outside [0, 1] to the nearest bound", () => {
		expect(clamp01(-0.5)).toBe(0);
		expect(clamp01(1.5)).toBe(1);
		expect(clamp01(-1000)).toBe(0);
		expect(clamp01(1000)).toBe(1);
	});

	it("maps NaN and infinities to 0 (the divergence the shared owner fixes)", () => {
		// Hand-rolled copies used `x < 0 ? 0 : x > 1 ? 1 : x`, which returns NaN
		// for NaN because both comparisons are false. The non-finite guard runs
		// first, so every non-finite input returns the low bound of 0, including
		// positive infinity, which never reaches the upper-bound clamp.
		expect(clamp01(Number.NaN)).toBe(0);
		expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
		expect(clamp01(Number.NEGATIVE_INFINITY)).toBe(0);
	});
});

// Source lock: clamp01 has exactly ONE owner, packages/utils/src/math.ts.
// Four hand-rolled copies (coding-agent/sun.ts, mnemopi helpers.ts + recall.ts,
// tui latex-to-unicode.ts) drifted on NaN handling before they were folded onto
// this owner. Import clamp01 from @veyyon/utils instead of writing another copy.
const PACKAGES_DIR = path.join(import.meta.dir, "../..");
const OWNER = "utils/src/math.ts";
const CLAMP01_DEF = /function\s+clamp01\s*\(/;

async function walkTsSources(dir: string, out: string[]): Promise<void> {
	let entries: import("node:fs").Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return; // package without that subdirectory
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "vendor") continue;
			await walkTsSources(full, out);
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
}

describe("clamp01 source lock", () => {
	it("no production source defines a local clamp01 outside the owner", async () => {
		const files: string[] = [];
		for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
			if (!pkg.isDirectory()) continue;
			await walkTsSources(path.join(PACKAGES_DIR, pkg.name, "src"), files);
		}
		const offenders: string[] = [];
		for (const file of files) {
			const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
			if (rel === OWNER) continue;
			if (CLAMP01_DEF.test(await readFile(file, "utf8"))) offenders.push(rel);
		}
		expect(offenders, "new local clamp01 copies — import it from @veyyon/utils instead").toEqual([]);
	});
});
