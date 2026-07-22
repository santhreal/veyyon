/**
 * The follow — silky-smooth reveal pacing + the lava-like hot trail.
 *
 * The user-reported defect this locks out: reasoning text rendered CHUNKED —
 * each provider burst (often a whole sentence) appeared in one frame. The
 * SmoothReveal governor must turn bursty arrivals into a paced reveal, and the
 * pacing must satisfy three hard properties:
 *  1. No dumping: a large burst never appears in a single advance step — the
 *     revealed count grows by bounded increments across frames.
 *  2. Convergence: the reveal always catches the stream (accelerating with
 *     lag), and the lag is HARD-bounded so smooth can never become stale.
 *  3. Finish is exact: `finish()` snaps to the full text, so a settled block
 *     never shows a truncated tail.
 *
 * paintHotTail: the trailing cells of the newest row grade to gold at the very
 * tip (theme matchHighlight). Truecolor only; without 24-bit color the row is
 * returned untouched (loud degrade: no trail at all, never a broken ramp).
 */
import { describe, expect, it } from "bun:test";
import { FOLLOW_TUNING, paintHotTail, SmoothReveal } from "@veyyon/coding-agent/modes/components/follow";
import type { ThemeJson } from "@veyyon/coding-agent/modes/theme/color";
import { defaultThemes } from "@veyyon/coding-agent/modes/theme/defaults";
import { createTheme } from "@veyyon/coding-agent/modes/theme/theme";

const theme = createTheme(defaultThemes.titanium as ThemeJson, { mode: "truecolor" });

describe("SmoothReveal — no dumping", () => {
	/** A 400-char burst landing at once must NOT appear in one frame: at 30fps
	 * each advance may only move a bounded slice, so the burst spreads over
	 * many frames. */
	it("spreads a single large burst across many frames", () => {
		const r = new SmoothReveal();
		r.push(10, 0);
		r.advance(0);
		r.push(410, 100); // one big burst
		const steps: number[] = [];
		let prev = r.revealed;
		for (let t = 133; t <= 3000; t += 33) {
			r.advance(t);
			steps.push(r.revealed - prev);
			prev = r.revealed;
			if (!r.behind) break;
		}
		// More than a handful of frames were needed, and no single frame dumped
		// the whole burst.
		expect(steps.length).toBeGreaterThan(5);
		expect(Math.max(...steps)).toBeLessThan(400);
	});
});

describe("SmoothReveal — convergence and the hard lag bound", () => {
	it("always catches up to a stalled stream", () => {
		const r = new SmoothReveal();
		r.push(50, 0);
		r.push(300, 500);
		for (let t = 533; t <= 20000 && r.behind; t += 33) r.advance(t);
		expect(r.behind).toBe(false);
		expect(r.revealed).toBe(300);
	});

	/** The reveal must never trail by more than hardSnapChars, no matter how
	 * fast text pours in — beyond that it snaps forward. */
	it("bounds the lag at hardSnapChars", () => {
		const r = new SmoothReveal();
		r.push(0, 0);
		r.push(10_000, 50);
		r.advance(83);
		expect(10_000 - r.revealed).toBeLessThanOrEqual(FOLLOW_TUNING.hardSnapChars);
	});

	/** finish() is exact — a settled block shows every character. */
	it("finish snaps to the full text", () => {
		const r = new SmoothReveal();
		r.push(1234, 0);
		r.finish();
		expect(r.revealed).toBe(1234);
		expect(r.behind).toBe(false);
	});

	/** A shrinking target (new block took over) restarts cleanly instead of
	 * showing a phantom tail from the previous block. */
	it("resets when the target shrinks", () => {
		const r = new SmoothReveal();
		r.push(500, 0);
		r.finish();
		r.push(20, 100);
		expect(r.revealed).toBeLessThanOrEqual(20);
	});
});

describe("paintHotTail — the lava-like trail", () => {
	it("paints the trailing cells, ending exactly on matchHighlight gold", () => {
		const row = "the reasoning tail of the current line";
		const out = paintHotTail(row, theme, true);
		expect(out.replace(/\x1b\[[0-9;]*m/g, "")).toBe(row);
		const gold = theme
			.getColorHex("matchHighlight")
			.replace("#", "")
			.match(/../g)!
			.map(h => parseInt(h, 16))
			.join(";");
		// The LAST color open before the final character is the exact gold.
		const opens = [...out.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m/g)].map(m => m[1]);
		expect(opens.length).toBe(FOLLOW_TUNING.hotTailCells);
		expect(opens[opens.length - 1]).toBe(gold);
		expect(out.endsWith("m" + row.slice(-1) + "\x1b[39m")).toBe(true);
	});

	it("grades monotonically warmer toward the tip (red channel never falls)", () => {
		const out = paintHotTail("abcdefghijklmnopqrstuvwxyz", theme, true);
		const reds = [...out.matchAll(/\x1b\[38;2;(\d+);\d+;\d+m/g)].map(m => Number(m[1]));
		for (let i = 1; i < reds.length; i++) expect(reds[i]!).toBeGreaterThanOrEqual(reds[i - 1]!);
	});

	it("returns short rows fully painted rather than crashing", () => {
		const out = paintHotTail("abc", theme, true);
		expect(out.replace(/\x1b\[[0-9;]*m/g, "")).toBe("abc");
	});

	/** Loud degrade: without truecolor there is NO trail — the row comes back
	 * byte-identical, never a 16-color approximation of the ramp. */
	it("is a no-op without 24-bit color", () => {
		const row = "plain reasoning text";
		expect(paintHotTail(row, theme, false)).toBe(row);
	});

	it("leaves an all-whitespace row untouched by the caller contract", () => {
		expect(paintHotTail("", theme, true)).toBe("");
	});

	/**
	 * The trail generalizes to tool surfaces (DS-4): a running tool's live
	 * stdout tail cools into `toolOutput`, not `thinkingText`. Locks the
	 * cooledToken parameter so the one gradient owner serves both surfaces —
	 * the OLDEST tail cell opens with the EXACT hex of the requested surface
	 * token (t=0 anchor of the mix), and the tip stays the same gold on both.
	 */
	it("cools into the surface named by cooledToken", () => {
		const rgbOf = (token: "thinkingText" | "toolOutput" | "matchHighlight") =>
			theme
				.getColorHex(token)
				.replace("#", "")
				.match(/../g)!
				.map(h => parseInt(h, 16))
				.join(";");
		const row = "streamed stdout line from a running bash tool";
		const thinking = paintHotTail(row, theme, true, "thinkingText");
		const tool = paintHotTail(row, theme, true, "toolOutput");
		expect(thinking.replace(/\x1b\[[0-9;]*m/g, "")).toBe(row);
		expect(tool.replace(/\x1b\[[0-9;]*m/g, "")).toBe(row);
		const opens = (s: string) => [...s.matchAll(/\x1b\[38;2;(\d+;\d+;\d+)m/g)].map(m => m[1]);
		expect(opens(tool)[0]).toBe(rgbOf("toolOutput"));
		expect(opens(thinking)[0]).toBe(rgbOf("thinkingText"));
		expect(opens(tool).at(-1)).toBe(rgbOf("matchHighlight"));
		expect(opens(thinking).at(-1)).toBe(rgbOf("matchHighlight"));
	});

	it("defaults cooledToken to thinkingText (reasoning callsites unchanged)", () => {
		const row = "default surface stays the reasoning one";
		expect(paintHotTail(row, theme, true)).toBe(paintHotTail(row, theme, true, "thinkingText"));
	});
});
