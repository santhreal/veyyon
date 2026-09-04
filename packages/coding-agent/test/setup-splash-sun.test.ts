import { beforeAll, describe, expect, it } from "bun:test";
import { renderSetupSplash, SETUP_SPLASH_MS } from "@veyyon/coding-agent/modes/terminal/setup-wizard/scenes/splash";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
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

describe("setup splash — the resting launch signature", () => {
	it("returns exactly `height` lines, each exactly `width` visible cells, at any progress", () => {
		for (const t of [0, SETUP_SPLASH_MS / 2, SETUP_SPLASH_MS]) {
			const out = renderSetupSplash(W, H, t);
			expect(out.length).toBe(H);
			for (const line of out) expect([...strip(line)].length).toBe(W);
		}
	});

	it("first frame (t = 0) renders the full resting disc immediately with no entrance lag", () => {
		const initial = filledCells(renderSetupSplash(W, H, 0));
		const late = filledCells(renderSetupSplash(W, H, SETUP_SPLASH_MS));
		// The first frame must be the finished frame: full resting disc on frame 0.
		expect(initial).toBeGreaterThan(0);
		expect(initial).toBe(late);
	});

	it("first frame (t = 0) includes the letterspaced lowercase wordmark and tagline on frame zero", () => {
		const firstFrame = strip(renderSetupSplash(W, H, 0).join("\n"));
		const wordmark = APP_NAME.split("").join(" ");
		expect(APP_NAME).toBe("veyyon"); // brand invariant: lowercase wordmark
		expect(firstFrame).toContain(wordmark);
		expect(firstFrame).toContain("coding agent");
	});

	/**
	 * The splash must always name both keys it answers to. This assertion pinned
	 * "press enter to skip", which the splash stopped rendering when the hint was
	 * rewritten to name Enter and Esc separately (Esc used to START setup here,
	 * so the one key a user reaches for to get out walked them further in). It
	 * asserted removed copy, so it failed on every run and pinned nothing.
	 */
	it("always names both keys the splash answers to", () => {
		const out = strip(renderSetupSplash(W, H, SETUP_SPLASH_MS * 0.3).join("\n"));
		expect(out).toContain("enter start setup");
		expect(out).toContain("esc skip setup");
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
