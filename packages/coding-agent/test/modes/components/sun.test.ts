import { describe, expect, test } from "bun:test";
import { ghostSunBar } from "../../../src/modes/components/composer-chrome";
import { renderSunField, type SunFieldOptions, sunMark } from "../../../src/modes/components/sun";

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

describe("ghostSunBar (the resting mark on the composer horizon)", () => {
	test("at rest it is a smooth symmetric dome, never a dither slice", () => {
		const bar = ghostSunBar(true, 0);
		expect(bar).not.toBeNull();
		const glyphs = strip(bar as string);
		expect(glyphs).toBe("▁▃▆█▆▃▁");
		// The old implementation sliced the dithered sun field, which painted
		// `·░▒▒▒░··` — one row of ordered dither reads as terminal corruption.
		expect(glyphs).not.toMatch(/[·:░▒▓]/);
	});

	test("sinking shrinks the dome monotonically and ends in null", () => {
		let prev = strip(ghostSunBar(true, 0) as string).replace(/ /g, "").length;
		for (const sink of [0.25, 0.5, 0.75]) {
			const bar = ghostSunBar(true, sink);
			const cells = bar === null ? 0 : strip(bar).replace(/ /g, "").length;
			expect(cells).toBeLessThan(prev);
			prev = cells;
		}
		expect(ghostSunBar(true, 1)).toBeNull();
	});

	test("non-truecolor terminals get the 256-colour ember ramp, same silhouette", () => {
		const bar = ghostSunBar(false, 0);
		expect(strip(bar as string)).toBe("▁▃▆█▆▃▁");
		expect(bar).toContain("\x1b[38;5;");
	});
});
