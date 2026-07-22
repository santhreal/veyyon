import { describe, expect, test } from "bun:test";
import {
	EMBER,
	emberBandEscape,
	GLYPH,
	renderEmberField,
	renderSunField,
	renderSunsetField,
	type SunFieldOptions,
	sunMark,
} from "../../../src/modes/components/sun";

/** The truecolor fg escape for an ember band, derived from the exported ramp so
 *  these tests pin the band-SELECTION logic while brand-conformance pins the ramp
 *  values themselves. */
const fgTrue = (band: number) => `\x1b[38;2;${EMBER[band].join(";")}m`;

/** Strip SGR escapes so we can assert on the glyph geometry. */
function strip(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const BASE = {
	cols: 64,
	rows: 24,
	cx: 32,
	cy: 12,
	radius: 14,
	time: 0.3,
	trueColor: true,
} as const;

describe("renderSunField geometry", () => {
	test("returns exactly `rows` lines, each exactly `cols` visible cells", () => {
		const out = renderSunField(BASE);
		expect(out.length).toBe(BASE.rows);
		for (const line of out) {
			expect([...strip(line)].length).toBe(BASE.cols);
		}
	});

	test("the centre is a solid disc and the far corners are empty ground", () => {
		const grid = renderSunField(BASE).map(strip);
		// Dead centre is the hottest band -> full block.
		expect(grid[BASE.cy][BASE.cx]).toBe("█");
		// Corners are well outside 1.26R -> spaces.
		expect(grid[0][0]).toBe(" ");
		expect(grid[BASE.rows - 1][BASE.cols - 1]).toBe(" ");
	});

	test("glyph density strictly falls off with radius (core denser than rim denser than void)", () => {
		const grid = renderSunField(BASE).map(strip);
		const filled = (y0: number, y1: number, x0: number, x1: number) => {
			let n = 0;
			for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (grid[y][x] !== " ") n++;
			return n / ((y1 - y0) * (x1 - x0));
		};
		// 6-col-wide vertical bands centred on the sun, measured over the full height.
		const core = filled(0, BASE.rows, BASE.cx - 3, BASE.cx + 3);
		const rim = filled(0, BASE.rows, BASE.cx - 12, BASE.cx - 6);
		const void_ = filled(0, BASE.rows, 0, 6);
		expect(core).toBeGreaterThan(rim);
		expect(rim).toBeGreaterThan(void_);
		expect(void_).toBe(0);
	});

	test("is deterministic — identical options give byte-identical output", () => {
		expect(renderSunField(BASE)).toEqual(renderSunField(BASE));
	});

	test("radius scales the disc: a bigger radius fills strictly more cells", () => {
		const count = (radius: number) =>
			renderSunField({ ...BASE, radius })
				.map(strip)
				.join("")
				.split("")
				.filter(c => c !== " ").length;
		expect(count(20)).toBeGreaterThan(count(10));
	});
});

describe("renderSunField colour", () => {
	test("truecolor path emits 24-bit ember foregrounds, not 256-colour", () => {
		const joined = renderSunField(BASE).join("");
		expect(joined).toContain("\x1b[38;2;255;227;173m"); // #ffe3ad, hottest ember
		expect(joined).not.toContain("\x1b[38;5;");
	});

	test("256-colour fallback emits palette indices, not truecolor", () => {
		const joined = renderSunField({ ...BASE, trueColor: false }).join("");
		expect(joined).toContain("\x1b[38;5;223m"); // hottest ember index
		expect(joined).not.toContain("\x1b[38;2;");
	});

	test("paintBackground lays a pitch-black ground under every row", () => {
		const out = renderSunField({ ...BASE, paintBackground: true });
		for (const line of out) expect(line.startsWith("\x1b[48;2;0;0;0m")).toBe(true);
	});
});

describe("renderSunField ripples", () => {
	test("an active flare perturbs the field vs the same frame with none", () => {
		const still = renderSunField(BASE).map(strip).join("");
		const rippled = renderSunField({
			...BASE,
			ripples: [{ x: BASE.cx, y: BASE.cy, age: 0.2, amp: 1 }],
		})
			.map(strip)
			.join("");
		expect(rippled).not.toBe(still);
	});

	test("an expired ripple (age past the window) has no effect", () => {
		const still = renderSunField(BASE).map(strip).join("");
		const expired = renderSunField({
			...BASE,
			ripples: [{ x: BASE.cx, y: BASE.cy, age: 99, amp: 1 }],
		})
			.map(strip)
			.join("");
		expect(expired).toBe(still);
	});
});

describe("renderSunField edge sizes (the UI can pass anything — never crash)", () => {
	// `typeof BASE` carries literal types (as const), so widen via the real options type.
	const cases: Array<[string, Partial<SunFieldOptions> & { cols: number; rows: number }]> = [
		["zero field", { cols: 0, rows: 0 }],
		["one cell", { cols: 1, rows: 1, cx: 0, cy: 0, radius: 1 }],
		["zero radius", { cols: 20, rows: 8, radius: 0 }],
		["radius far larger than field", { cols: 20, rows: 8, radius: 999 }],
		["centre off the field (negative)", { cols: 20, rows: 8, cx: -50, cy: -50 }],
		["centre off the field (past edge)", { cols: 20, rows: 8, cx: 999, cy: 999 }],
		["tall sliver", { cols: 1, rows: 40, radius: 8 }],
		["wide sliver", { cols: 120, rows: 1, radius: 8 }],
	];
	for (const [name, over] of cases) {
		test(`${name} renders without throwing and honors dimensions`, () => {
			const opts = { ...BASE, ...over };
			let out: string[] = [];
			expect(() => {
				out = renderSunField(opts);
			}).not.toThrow();
			expect(out.length).toBe(opts.rows);
			for (const line of out) expect([...strip(line)].length).toBe(opts.cols);
		});
	}

	test("zero radius still produces a valid (tiny or empty) hot spot, never NaN glyphs", () => {
		const out = renderSunField({ ...BASE, radius: 0 })
			.map(strip)
			.join("");
		expect(out).not.toContain("NaN");
		expect(out).not.toContain("undefined");
	});
});

describe("sunMark (the launch-signature recipe)", () => {
	const fill = (lines: string[]) =>
		lines
			.map(strip)
			.join("")
			.split("")
			.filter(c => c !== " ").length;

	test("rests at a full round disc (no bloom): centre is solid, sized to the slot", () => {
		const out = sunMark(16, 7, { trueColor: true });
		expect(out.length).toBe(7);
		for (const line of out) expect([...strip(line)].length).toBe(16);
		expect(strip(out[3])).toContain("█");
	});

	test("bloom eases the disc open — strictly more cells as bloom rises 0 → 1", () => {
		const p0 = fill(sunMark(16, 7, { trueColor: true, bloom: 0 }));
		const pHalf = fill(sunMark(16, 7, { trueColor: true, bloom: 0.5 }));
		const p1 = fill(sunMark(16, 7, { trueColor: true, bloom: 1 }));
		expect(p0).toBeLessThan(pHalf);
		expect(pHalf).toBeLessThan(p1);
	});

	test("omitting bloom equals a fully-bloomed mark (rests at full)", () => {
		expect(sunMark(16, 7, { trueColor: true })).toEqual(sunMark(16, 7, { trueColor: true, bloom: 1 }));
	});

	test("honors the 256-colour fallback", () => {
		const joined = sunMark(16, 7, { trueColor: false }).join("");
		expect(joined).toContain("\x1b[38;5;");
		expect(joined).not.toContain("\x1b[38;2;");
	});
});

// emberBandEscape maps a 0..1 heat ratio to a foreground escape on the ember
// ramp. The contract that matters is the band-selection formula (band =
// 2 + round(ratio * 5), clamped): the cold end starts at band 2 so text stays
// legible, the hot end reaches band 7, and it never leaves the ramp. These lock
// that formula so a refactor cannot quietly start text at band 0 (near-black,
// illegible) or run off the end of the array.
describe("emberBandEscape (heat ratio → ember fg)", () => {
	test("ratio 0 is the cold coal band (band 2), not near-black band 0", () => {
		expect(emberBandEscape(0, true)).toBe(fgTrue(2));
	});

	test("ratio 1 is white-hot (band 7)", () => {
		expect(emberBandEscape(1, true)).toBe(fgTrue(7));
	});

	test("walks the ramp bands 2→7 in even steps as heat rises", () => {
		// 2 + round(r*5) for r = 0, .2, .4, .6, .8, 1 → bands 2,3,4,5,6,7.
		expect([0, 0.2, 0.4, 0.6, 0.8, 1].map(r => emberBandEscape(r, true))).toEqual([2, 3, 4, 5, 6, 7].map(fgTrue));
	});

	test("clamps out-of-range ratios to the ramp ends", () => {
		expect(emberBandEscape(-5, true)).toBe(emberBandEscape(0, true));
		expect(emberBandEscape(9, true)).toBe(emberBandEscape(1, true));
	});

	test("256-colour mode emits a 256 escape, distinct per end, never truecolor", () => {
		const cold = emberBandEscape(0, false);
		const hot = emberBandEscape(1, false);
		expect(cold).toMatch(/^\x1b\[38;5;\d+m$/);
		expect(hot).toMatch(/^\x1b\[38;5;\d+m$/);
		expect(cold).not.toBe(hot);
		expect(cold).not.toContain("38;2;");
	});
});

// renderSunsetField is the ceremony's closing beat: a dithered sky painted as
// background cells, an ember sun cap poking above a hot horizon rule, and sparks
// drifting up. These pin the frame's structure — line count, the horizon rule,
// the page-black ground below it, custom horizon placement, sky-as-background vs
// sun-as-foreground, determinism, and the 256 fallback.
describe("renderSunsetField (the sunset finale)", () => {
	const BASE_SUNSET = { cols: 40, rows: 12, time: 0.3, trueColor: true } as const;
	// horizonY defaults to round(rows * 0.78) → round(9.36) = 9.
	const DEFAULT_HORIZON = 9;

	test("returns exactly `rows` lines", () => {
		expect(renderSunsetField(BASE_SUNSET).length).toBe(12);
	});

	test("the horizon is one solid rule of `cols` dashes", () => {
		const out = renderSunsetField(BASE_SUNSET);
		expect(strip(out[DEFAULT_HORIZON])).toBe("─".repeat(40));
		expect(out[DEFAULT_HORIZON]).toContain("\x1b[38;2;251;192;109m"); // the hot horizon color
	});

	test("everything below the horizon is empty — the ground stays page-black", () => {
		const out = renderSunsetField(BASE_SUNSET);
		for (let y = DEFAULT_HORIZON + 1; y < 12; y++) expect(out[y]).toBe("");
	});

	test("a custom horizonY moves the rule and the empty ground with it", () => {
		const out = renderSunsetField({ ...BASE_SUNSET, horizonY: 3 });
		expect(strip(out[3])).toBe("─".repeat(40));
		expect(out[4]).toBe("");
	});

	test("sky is painted as background cells, the sun cap as foreground glyphs", () => {
		const above = renderSunsetField(BASE_SUNSET).slice(0, DEFAULT_HORIZON);
		const joined = above.join("");
		expect(joined).toContain("\x1b[48;2;"); // truecolor background = sky
		expect(strip(joined)).toMatch(/[░▒▓█]/); // an ember glyph = the sun cap above the line
	});

	test("is deterministic for a fixed time", () => {
		expect(renderSunsetField(BASE_SUNSET)).toEqual(renderSunsetField(BASE_SUNSET));
	});

	test("256-colour mode uses the 256 ramps, never truecolor", () => {
		const joined = renderSunsetField({ ...BASE_SUNSET, trueColor: false }).join("");
		expect(joined).toContain("\x1b[48;5;");
		expect(joined).not.toContain("\x1b[48;2;");
		expect(joined).not.toContain("\x1b[38;2;");
	});
});

// renderEmberField is the churn texture with no disc — the material the pause
// bars are cut from. These pin its rectangular shape, that every cell is a ramp
// glyph, determinism per (time, seed), that the seed actually decorrelates two
// fields, that base raises the heat, and the 256 fallback.
describe("renderEmberField (the churn texture)", () => {
	const BASE_EMBER = { cols: 24, rows: 4, time: 0.3, trueColor: true } as const;
	const GLYPH_SET = new Set<string>(GLYPH);

	test("returns a full `rows` × `cols` grid of ramp glyphs", () => {
		const out = renderEmberField(BASE_EMBER);
		expect(out.length).toBe(4);
		for (const line of out) expect([...strip(line)].length).toBe(24);
		expect([...strip(out.join(""))].every(c => GLYPH_SET.has(c))).toBe(true);
	});

	test("is deterministic for a fixed time and seed", () => {
		expect(renderEmberField(BASE_EMBER)).toEqual(renderEmberField(BASE_EMBER));
	});

	test("the seed decorrelates two fields so they don't churn in lockstep", () => {
		expect(renderEmberField({ ...BASE_EMBER, seed: 0 })).not.toEqual(renderEmberField({ ...BASE_EMBER, seed: 100 }));
	});

	test("a higher base raises the heat — more solid cells", () => {
		const solids = (lines: string[]) => [...strip(lines.join(""))].filter(c => c === "█").length;
		const cool = solids(renderEmberField({ ...BASE_EMBER, base: 0.1 }));
		const hot = solids(renderEmberField({ ...BASE_EMBER, base: 0.95 }));
		expect(hot).toBeGreaterThan(cool);
	});

	test("256-colour mode uses the 256 ramp, never truecolor", () => {
		const joined = renderEmberField({ ...BASE_EMBER, trueColor: false }).join("");
		expect(joined).toContain("\x1b[38;5;");
		expect(joined).not.toContain("\x1b[38;2;");
	});
});
