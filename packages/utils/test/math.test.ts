import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { clamp, clamp01, clampLow } from "../src/math";

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

describe("clampLow", () => {
	it("behaves like clamp when the range is non-empty", () => {
		expect(clampLow(5, 0, 10)).toBe(5);
		expect(clampLow(-3, 0, 10)).toBe(0);
		expect(clampLow(42, 0, 10)).toBe(10);
		expect(clampLow(-1, -5, -2)).toBe(-2);
	});

	it("prefers the low bound when the range is empty (high < low) — the divergence from clamp", () => {
		// The canonical index case: clamping into a list of length zero
		// (low 0, high len-1 = -1). clampLow returns 0 (a usable floor); clamp
		// would return the inverted -1. This is why index/offset/scroll math uses
		// the floor-first form.
		expect(clampLow(3, 0, -1)).toBe(0);
		expect(clamp(3, 0, -1)).toBe(-1);
		expect(clampLow(-5, 2, 1)).toBe(2);
	});

	it("maps non-finite inputs to the low bound", () => {
		expect(clampLow(Number.NaN, 2, 8)).toBe(2);
		expect(clampLow(Number.POSITIVE_INFINITY, 2, 8)).toBe(2);
		expect(clampLow(Number.NEGATIVE_INFINITY, 2, 8)).toBe(2);
	});
});

// Source lock: clamp and clamp01 have exactly ONE owner, packages/utils/src/math.ts.
// Hand-rolled copies drifted on NaN handling before they were folded onto this
// owner: local clamp01 copies (coding-agent/sun.ts, mnemopi helpers.ts +
// recall.ts, tui latex-to-unicode.ts) and a whole second `clamp` owner in
// tui/utils.ts whose docstring documented the opposite non-finite behavior.
// Import clamp/clamp01 from @veyyon/utils instead of writing another copy.
const PACKAGES_DIR = path.join(import.meta.dir, "../..");
const OWNER = "utils/src/math.ts";
const CLAMP01_DEF = /function\s+clamp01\s*\(/;
// `clamp\s*\(` matches `function clamp(` but not `clamp01(` (which is `clamp` + `01`)
// nor `clampFoo(`, so a second same-name owner is caught without false positives.
const CLAMP_DEF = /function\s+clamp\s*\(/;
const CLAMPLOW_DEF = /function\s+clampLow\s*\(/;

async function walkTsSources(dir: string, out: string[], skipModes = false): Promise<void> {
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
			// The coding-agent modes/ subtree is a separately owned UI lane; the
			// inline-idiom lock does not reach into it.
			if (skipModes && entry.name === "modes") continue;
			await walkTsSources(full, out, skipModes);
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			out.push(full);
		}
	}
}

/**
 * Detect a hand-rolled two-bound clamp: `Math.min(Math.max(v, lo), hi)` or the
 * mirror `Math.max(Math.min(v, hi), lo)`, where the inner call's result is the
 * outer call's first argument (a comma follows the inner close paren). This is
 * exactly `clamp(v, lo, hi)`. It deliberately ignores floor-then-scale shapes
 * like `Math.min(Math.max(x, 0) * k, hi)`, where an operator, not a comma,
 * follows the inner call, so those legitimate compositions are not flagged.
 */
function hasInlineClamp(text: string): boolean {
	for (const [outer, inner] of [
		["min", "max"],
		["max", "min"],
	]) {
		const needle = `Math.${outer}(Math.${inner}(`;
		const innerNameLen = `Math.${outer}(Math.${inner}`.length;
		let from = 0;
		let idx = text.indexOf(needle, from);
		while (idx !== -1) {
			from = idx + needle.length;
			let depth = 0;
			let end = -1;
			for (let j = idx + innerNameLen; j < text.length; j++) {
				const c = text[j];
				if (c === "(") depth++;
				else if (c === ")") {
					depth--;
					if (depth === 0) {
						end = j;
						break;
					}
				}
			}
			if (end !== -1) {
				let k = end + 1;
				while (k < text.length && /\s/.test(text[k] ?? "")) k++;
				if (text[k] === ",") return true;
			}
			idx = text.indexOf(needle, from);
		}
	}
	return false;
}

/**
 * Detect the floor-first idiom `Math.max(lo, Math.min(value, high))`, which is
 * exactly `clampLow(value, lo, high)`. The marker is a `Math.min(...)` call that
 * is the LAST top-level argument of an enclosing `Math.max(...)` — its close
 * paren is immediately followed by the outer max's close paren (only whitespace
 * between). It requires the inner `Math.min` to take exactly two arguments, so
 * an irreducible `Math.max(0, Math.min(a, b, c))` (a floor over the min of
 * several bounds — not a two-bound clampLow) is left alone. This is the mirror
 * of {@link hasInlineClamp}, whose `["max","min"]` branch instead matches the
 * min as the FIRST argument of the max (a comma, not a paren, after its close).
 */
function hasFloorFirst(text: string): boolean {
	const needle = "Math.max(";
	let idx = text.indexOf(needle);
	while (idx !== -1) {
		const open = idx + needle.length - 1; // position of the outer '('
		let depth = 0;
		let lastArgStart = -1;
		let closeIdx = -1;
		for (let j = open; j < text.length; j++) {
			const c = text[j];
			if (c === "(") {
				depth++;
				if (depth === 1) lastArgStart = j + 1;
			} else if (c === ")") {
				depth--;
				if (depth === 0) {
					closeIdx = j;
					break;
				}
			} else if (c === "," && depth === 1) {
				lastArgStart = j + 1;
			}
		}
		if (closeIdx !== -1 && lastArgStart !== -1) {
			let s = lastArgStart;
			while (s < closeIdx && /\s/.test(text[s] ?? "")) s++;
			if (text.startsWith("Math.min(", s)) {
				let d = 0;
				let minEnd = -1;
				let topCommas = 0;
				for (let j = s + "Math.min".length; j < text.length; j++) {
					const c = text[j];
					if (c === "(") d++;
					else if (c === ")") {
						d--;
						if (d === 0) {
							minEnd = j;
							break;
						}
					} else if (c === "," && d === 1) topCommas++;
				}
				if (minEnd !== -1 && topCommas === 1) {
					let k = minEnd + 1;
					while (k < closeIdx && /\s/.test(text[k] ?? "")) k++;
					if (k === closeIdx) return true;
				}
			}
		}
		idx = text.indexOf(needle, idx + needle.length);
	}
	return false;
}

// Floor-first survivors that genuinely cannot fold onto clampLow:
//   - tab-worker.ts runs its bodies inside `handle.evaluate(el => {...})`, which
//     executes in the browser page where imported module symbols are undefined;
//     `Math` is the only clamp primitive available there.
//   - experiments.ts clamps a logit that is deliberately ±Infinity for unanimous
//     arms, and raw `Math.max(-4, Math.min(4, x))` maps +Infinity to +4. clampLow
//     maps non-finite inputs to its LOW bound (-4), which would flip the sign.
const FLOOR_FIRST_GRANDFATHERED = new Set([
	"coding-agent/src/tools/browser/tab-worker.ts",
	"metaharness/src/experiments.ts",
]);

describe("clamp source lock", () => {
	it("hasInlineClamp matches pure clamps but not floor-then-scale or floor-first shapes", () => {
		expect(hasInlineClamp("Math.min(Math.max(x, 0), 1)")).toBe(true);
		expect(hasInlineClamp("Math.max(Math.min(x, 1), 0)")).toBe(true);
		expect(hasInlineClamp("Math.min(Math.max(cursor, 0), text.length)")).toBe(true);
		// Operator (not comma) after the inner call: a floor-then-scale composition.
		expect(hasInlineClamp("Math.min(Math.max(0, baseDelayMs) * 2 ** attempt, MAX)")).toBe(false);
		expect(hasInlineClamp("Math.min(Math.max(seconds, 0) * 1000, MAX)")).toBe(false);
		// Floor-first `Math.max(lo, Math.min(...))` is a different idiom, not targeted here.
		expect(hasInlineClamp("Math.max(0, Math.min(a, b))")).toBe(false);
	});

	it("hasFloorFirst matches the two-bound clampLow idiom but not three-bound mins or compositions", () => {
		expect(hasFloorFirst("Math.max(0, Math.min(a, b))")).toBe(true);
		expect(hasFloorFirst("Math.max(lo, Math.min(target + d * dir, hi))")).toBe(true);
		expect(hasFloorFirst("Math.max(1, Math.min(1000, Math.floor(x)))")).toBe(true);
		// Three-argument min is a floor over several bounds, not a two-bound clampLow.
		expect(hasFloorFirst("Math.max(0, Math.min(a, b, c))")).toBe(false);
		// min is the FIRST arg of max (the plain clamp idiom), not the last.
		expect(hasFloorFirst("Math.max(Math.min(x, 1), 0)")).toBe(false);
		// A trailing operator means the last arg is a composition, not a bare min.
		expect(hasFloorFirst("Math.max(0, Math.min(a, b) + 1)")).toBe(false);
	});

	it("no production source defines a local clamp/clamp01/clampLow, or inlines the clamp or floor-first idiom", async () => {
		const defFiles: string[] = [];
		const idiomFiles: string[] = [];
		for (const pkg of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
			if (!pkg.isDirectory()) continue;
			await walkTsSources(path.join(PACKAGES_DIR, pkg.name, "src"), defFiles);
			await walkTsSources(path.join(PACKAGES_DIR, pkg.name, "src"), idiomFiles, true);
			await walkTsSources(path.join(PACKAGES_DIR, pkg.name, "scripts"), defFiles);
			await walkTsSources(path.join(PACKAGES_DIR, pkg.name, "scripts"), idiomFiles, true);
		}
		const defOffenders: string[] = [];
		for (const file of defFiles) {
			const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
			if (rel === OWNER) continue;
			const body = await readFile(file, "utf8");
			if (CLAMP01_DEF.test(body) || CLAMP_DEF.test(body) || CLAMPLOW_DEF.test(body)) defOffenders.push(rel);
		}
		expect(defOffenders, "local clamp/clamp01/clampLow copies — import them from @veyyon/utils instead").toEqual([]);

		const idiomOffenders: string[] = [];
		const floorFirstOffenders: string[] = [];
		for (const file of idiomFiles) {
			const rel = path.relative(PACKAGES_DIR, file).replaceAll(path.sep, "/");
			if (rel === OWNER) continue;
			const body = await readFile(file, "utf8");
			if (hasInlineClamp(body)) idiomOffenders.push(rel);
			if (!FLOOR_FIRST_GRANDFATHERED.has(rel) && hasFloorFirst(body)) floorFirstOffenders.push(rel);
		}
		expect(idiomOffenders, "inline Math.min(Math.max(...)) clamp — call clamp()/clamp01() instead").toEqual([]);
		expect(
			floorFirstOffenders,
			"inline Math.max(lo, Math.min(v, hi)) floor-first clamp — call clampLow(v, lo, hi) instead",
		).toEqual([]);
	});
});
