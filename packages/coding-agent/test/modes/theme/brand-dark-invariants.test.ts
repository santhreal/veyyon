/**
 * Brand invariants for the shipped `dark` theme (see docs/handbook/src/design/brand.md).
 *
 * Locks the corrected brand model into a contract test so a future edit cannot
 * silently reintroduce a non-black surface, drop the deep-blue highlight, or
 * revert links to silver:
 *   - ground is pitch black: every background token is exactly #000000
 *   - deep blue #4A84C9 is present as the single highlight
 *   - links (the highest-frequency highlight) resolve to blue, not silver
 *   - silver #B8BDC7 remains the structural accent
 *   - no color references a var that does not exist (integrity)
 */
import { describe, expect, it } from "bun:test";
import darkThemeJson from "../../../src/modes/theme/dark.json" with { type: "json" };

const dark = darkThemeJson as {
	vars: Record<string, string>;
	colors: Record<string, string | number>;
	export?: Record<string, string>;
};

const BLACK = "#000000";
const DEEP_BLUE = "#4A84C9";
const SILVER = "#B8BDC7";

describe("dark theme brand invariants", () => {
	it("keeps every background token pitch black", () => {
		const bgEntries: Array<[string, string]> = [];
		for (const [k, v] of Object.entries(dark.vars)) {
			if (/bg$/i.test(k) && typeof v === "string" && v.startsWith("#")) bgEntries.push([`vars.${k}`, v]);
		}
		for (const [k, v] of Object.entries(dark.export ?? {})) {
			if (/bg$/i.test(k) && typeof v === "string") bgEntries.push([`export.${k}`, v]);
		}
		// resolve string-referenced background colors too
		for (const [k, v] of Object.entries(dark.colors)) {
			if (!/bg$/i.test(k)) continue;
			if (typeof v !== "string") continue;
			const resolved = dark.vars[v] ?? v;
			if (resolved.startsWith("#")) bgEntries.push([`colors.${k}`, resolved]);
		}
		expect(bgEntries.length).toBeGreaterThan(5);
		for (const [name, hex] of bgEntries) {
			expect(`${name}=${hex.toUpperCase()}`).toBe(`${name}=${BLACK}`);
		}
	});

	it("defines deep blue #4A84C9 as the highlight and silver #B8BDC7 as the accent", () => {
		expect(dark.vars.blue?.toUpperCase()).toBe(DEEP_BLUE);
		expect(dark.vars.accent?.toUpperCase()).toBe(SILVER);
	});

	it("routes links through the blue highlight, not silver", () => {
		// mdLink/link may reference the `blue` var or the literal hex; both must land on deep blue.
		for (const key of ["mdLink", "link"] as const) {
			const raw = dark.colors[key];
			expect(typeof raw).toBe("string");
			const resolved = (dark.vars[raw as string] ?? (raw as string)).toUpperCase();
			expect(`${key}=${resolved}`).toBe(`${key}=${DEEP_BLUE}`);
		}
	});

	it("has no color referencing a missing var (integrity)", () => {
		const dangling: string[] = [];
		for (const [k, v] of Object.entries(dark.colors)) {
			if (typeof v !== "string") continue; // numeric = 256-color index
			if (v.startsWith("#")) continue; // literal hex
			if (!(v in dark.vars)) dangling.push(`${k} -> ${v}`);
		}
		expect(dangling).toEqual([]);
	});
});
