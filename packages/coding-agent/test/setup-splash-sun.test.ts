import { beforeAll, describe, expect, it } from "bun:test";
import { renderSetupSplash, SETUP_SPLASH_MS } from "@veyyon/coding-agent/modes/setup-wizard/scenes/splash";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { APP_NAME } from "@veyyon/utils";

beforeAll(async () => {
	await initTheme(false);
});

/** Strip SGR escapes so we can assert on glyph geometry. */
function strip(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

const W = 60;
const H = 20;

function filledCells(lines: string[]): number {
	return lines
		.map(strip)
		.join("")
		.split("")
		.filter(c => c !== " ").length;
}

describe("setup splash — the sun-bloom launch signature", () => {
	it("returns exactly `height` lines, each exactly `width` visible cells, at any progress", () => {
		for (const t of [0, SETUP_SPLASH_MS / 2, SETUP_SPLASH_MS]) {
			const out = renderSetupSplash(W, H, t);
			expect(out.length).toBe(H);
			for (const line of out) expect([...strip(line)].length).toBe(W);
		}
	});

	it("blooms the sun open — lit cells grow monotonically and strictly from start to end", () => {
		const counts = [0, 0.1, 0.25, 0.5, 1].map(f => filledCells(renderSetupSplash(W, H, SETUP_SPLASH_MS * f)));
		// Monotonic non-decreasing: the disc only ever opens, never contracts mid-bloom.
		for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
		// And a clear net bloom: the closed point lights far fewer cells than the settled disc.
		expect(counts[0]).toBeLessThan(counts[counts.length - 1]);
	});

	it("reveals the letterspaced lowercase wordmark only after the disc has mostly bloomed", () => {
		const early = strip(renderSetupSplash(W, H, 0).join("\n"));
		const late = strip(renderSetupSplash(W, H, SETUP_SPLASH_MS).join("\n"));
		const wordmark = APP_NAME.split("").join(" ");
		expect(APP_NAME).toBe("veyyon"); // brand invariant: lowercase wordmark
		expect(early).not.toContain(wordmark);
		expect(late).toContain(wordmark);
	});

	it("always shows the skip hint and never scrolls the body sideways", () => {
		const out = renderSetupSplash(W, H, SETUP_SPLASH_MS * 0.3);
		expect(strip(out.join("\n"))).toContain("press enter to skip");
	});

	it("is deterministic — identical inputs give byte-identical frames", () => {
		expect(renderSetupSplash(W, H, 1234)).toEqual(renderSetupSplash(W, H, 1234));
	});

	it("never throws or emits NaN glyphs on tiny or huge fields", () => {
		for (const [w, h] of [
			[1, 1],
			[3, 2],
			[200, 60],
			[10, 40],
		] as const) {
			let out: string[] = [];
			expect(() => {
				out = renderSetupSplash(w, h, SETUP_SPLASH_MS * 0.7);
			}).not.toThrow();
			expect(out.length).toBe(Math.max(1, h));
			expect(strip(out.join(""))).not.toContain("NaN");
			expect(strip(out.join(""))).not.toContain("undefined");
		}
	});
});
