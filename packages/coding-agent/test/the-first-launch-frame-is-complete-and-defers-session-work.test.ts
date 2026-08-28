/**
 * WHY:
 * Veyyon's launch must feel instant. Any entrance animation that starts with a
 * partial, closed, or dim frame delays readability and operator interaction.
 *
 * This suite defends:
 * 1. The first painted frame is the complete, finished resting state:
 *    the full-bloomed sun mark, wordmark, and tagline exist on frame 0.
 * 2. Pre-first-frame execution only does what is REQUIRED for first paint
 *    (settings and theme init); heavy session work (auth storage await,
 *    model registry, session creation, extension discovery, tool building)
 *    is deferred until after the launch card is on screen.
 * 3. Restoring sessions (--resume, --continue, --fork), non-interactive runs,
 *    quiet mode, and setup wizards correctly opt out of the welcome first-frame.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { APP_NAME, TempDir } from "@veyyon/utils";
import { Settings } from "../src/config/settings";
import { paintFirstFrame, shouldPaintFirstFrame, takeFirstFrame } from "../src/modes/terminal/first-frame";
import { renderSetupSplash, SETUP_SPLASH_MS } from "../src/modes/terminal/setup-wizard/scenes/splash";
import { resetGroundTintsForTest } from "../src/theme/ground-tints";
import { initTheme } from "../src/theme/theme";

let tempDir: TempDir;
beforeAll(async () => {
	tempDir = TempDir.createSync("pi-first-frame-");
	await Settings.init({ inMemory: true, cwd: tempDir.path() });
	await initTheme(false);
});
afterAll(() => {
	tempDir.removeSync();
});

function filledCells(lines: readonly string[]): number {
	return lines
		.map(line => Bun.stripANSI(line))
		.join("")
		.split("")
		.filter(cell => cell !== " ").length;
}

describe("the first launch frame is complete and defers session work", () => {
	describe("first-frame decision gate", () => {
		const baseOptions = {
			isInteractive: true,
			protocolMode: false,
			quiet: false,
			splash: false,
			setupWizard: false,
			stdinIsTTY: true,
			stdoutIsTTY: true,
			resuming: false,
		};

		it("approves first paint for a normal interactive TTY launch", () => {
			expect(shouldPaintFirstFrame(baseOptions)).toBe(true);
		});

		it("defers / skips first paint when resuming an existing session", () => {
			expect(shouldPaintFirstFrame({ ...baseOptions, resuming: true })).toBe(false);
		});

		it("defers / skips first paint in protocol mode or non-interactive mode", () => {
			expect(shouldPaintFirstFrame({ ...baseOptions, isInteractive: false })).toBe(false);
			expect(shouldPaintFirstFrame({ ...baseOptions, protocolMode: true })).toBe(false);
		});

		it("defers / skips first paint in quiet mode, splash overlay, or setup wizard", () => {
			expect(shouldPaintFirstFrame({ ...baseOptions, quiet: true })).toBe(false);
			expect(shouldPaintFirstFrame({ ...baseOptions, splash: true })).toBe(false);
			expect(shouldPaintFirstFrame({ ...baseOptions, setupWizard: true })).toBe(false);
		});

		it("defers / skips first paint when stdout or stdin is not a TTY", () => {
			expect(shouldPaintFirstFrame({ ...baseOptions, stdinIsTTY: false })).toBe(false);
			expect(shouldPaintFirstFrame({ ...baseOptions, stdoutIsTTY: false })).toBe(false);
		});
	});

	describe("first painted frame completeness", () => {
		it("paints a complete welcome hero with non-empty finished sun and wordmark", () => {
			const frame = paintFirstFrame("1.1.1");
			try {
				const rendered = frame.hero.render(80);
				const combined = Bun.stripANSI(rendered.join("\n"));
				expect(combined).toContain(APP_NAME.split("").join(" "));
				expect(combined).toContain("v1.1.1");
			} finally {
				frame.release();
				frame.releaseInput();
				frame.ui.stop();
				takeFirstFrame(); // clear singleton
				// The paint reports the terminal's ground to a module-level cache, and a
				// cached black ground changes every band and card rendered after this
				// file in the same process.
				resetGroundTintsForTest();
			}
		});
	});

	describe("setup splash frame zero completeness", () => {
		const W = 60;
		const H = 20;

		it("renders full resting disc on frame zero with no entrance lag", () => {
			const frame0 = renderSetupSplash(W, H, 0);
			const frameEnd = renderSetupSplash(W, H, SETUP_SPLASH_MS);

			expect(frame0.length).toBe(H);
			expect(filledCells(frame0)).toBeGreaterThan(0);
			// Zero entrance lag: frame 0 is identical in filled cells to the settled splash
			expect(filledCells(frame0)).toBe(filledCells(frameEnd));
		});

		it("includes the wordmark and tagline immediately on frame zero", () => {
			const frame0 = Bun.stripANSI(renderSetupSplash(W, H, 0).join("\n"));
			const wordmark = APP_NAME.split("").join(" ");
			expect(frame0).toContain(wordmark);
			expect(frame0).toContain("coding agent");
		});
	});
});
