// WHY THIS EXISTS.
//
// Every bar in the product is now drawn in eighths of a cell, out of `▏▎▍▌▋▊▉`.
// Those are Block Elements, not ASCII, and a font without them draws a
// replacement box: a bar with a hole punched in it exactly where the value is,
// which is worse than the coarse bar it replaced. The product already knows
// which terminals cannot be sent such a glyph — that is what the `ascii` symbol
// preset is for, and it is why box drawing falls back to `+-|` — so the bar
// ramp is a per-preset table beside the spinner frames rather than a constant.
//
// The class this closes: "a glyph vocabulary added to one preset and not the
// others". The variant space is read out of `BAR_RAMPS` and `SYMBOL_PRESETS` at
// run time, and a preset present in one and missing from the other fails here,
// so a fourth preset cannot be added with its bar left as an oversight. Each
// preset is then swept across every eighth of a full bar and every glyph it
// emits is checked against its OWN ramp, rather than one representative ratio
// being spot-checked.
//
// The last test is the seam itself: a theme file asking for `ascii` has to reach
// the function that draws the bar. A preset that resolves correctly on the Theme
// and is then ignored by the renderer is the same defect with a longer path.
//
// What it does NOT catch: whether a particular FONT has the partial blocks (the
// preset is the operator's declaration about that, and there is nothing to
// measure from inside the process), and the glyph arithmetic itself, which is
// asserted in `packages/tui/test/a-bar-moves-in-eighths-of-a-cell.test.ts`.

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { BAR_RAMPS, SYMBOL_PRESETS } from "@veyyon/coding-agent/modes/theme/symbols";
import { getThemeByName, setThemeInstance, type Theme } from "@veyyon/coding-agent/modes/theme/theme";
import { renderAsciiBar } from "@veyyon/coding-agent/slash-commands/helpers/format";
import { EIGHTH_BLOCKS, subCellBar } from "@veyyon/tui/sub-cell-bar";
import {
	captureDirOverrides,
	getCustomThemesDir,
	removeWithRetries,
	restoreDirOverrides,
	setAgentDir,
} from "@veyyon/utils";

const DARK_THEME_PATH = path.join(import.meta.dir, "..", "src", "modes", "theme", "dark.json");
const dirOverrides = captureDirOverrides();

/** Colour stub, so these assertions see glyphs and not SGR. */
const plainTheme = {
	fg: (_color: Parameters<Theme["fg"]>[0], text: string): string => text,
	bold: (text: string): string => text,
	getFgAnsi: (): string => "",
};

let darkTheme: Theme;

describe("an ascii terminal is never sent a partial block", () => {
	beforeAll(async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		darkTheme = loaded;
		setThemeInstance(darkTheme);
	});

	it("declares a bar ramp for exactly the presets that exist", () => {
		// Read out of the source tables, so a fourth preset turns this red rather
		// than shipping with whatever ramp the lookup happens to return.
		expect(Object.keys(BAR_RAMPS).sort()).toEqual(Object.keys(SYMBOL_PRESETS).sort());
	});

	it("emits nothing outside its own ramp, for every preset at every eighth of a full bar", () => {
		for (const [preset, ramp] of Object.entries(BAR_RAMPS)) {
			const allowed = new Set([ramp.full, ramp.track, ...ramp.partials]);
			const width = 10;
			for (let step = 0; step <= width * 8; step++) {
				const bar = subCellBar(step / (width * 8), width, { ramp });
				expect(bar.length).toBe(width);
				for (const glyph of bar) {
					if (!allowed.has(glyph)) {
						throw new Error(`preset ${preset} emitted ${JSON.stringify(glyph)}, which is not in its ramp`);
					}
				}
			}
		}
	});

	it("gives the ascii preset a ramp with no partials, so no block glyph is reachable", () => {
		expect(BAR_RAMPS.ascii.partials).toEqual([]);
		expect(BAR_RAMPS.ascii.full).toBe("#");
		expect(BAR_RAMPS.ascii.track).toBe("-");
		for (let step = 0; step <= 80; step++) {
			const bar = subCellBar(step / 80, 10, { ramp: BAR_RAMPS.ascii });
			expect(bar).toMatch(/^#*-*$/);
			for (const block of EIGHTH_BLOCKS) expect(bar).not.toContain(block);
		}
		// And the unicode presets DO carry them, or this test passes by drawing
		// nothing anywhere.
		expect(BAR_RAMPS.unicode.partials).toEqual([...EIGHTH_BLOCKS]);
		expect(BAR_RAMPS.nerd.partials).toEqual([...EIGHTH_BLOCKS]);
	});

	describe("through a theme file that asks for the ascii preset", () => {
		let tmpAgentDir: string;

		afterEach(async () => {
			// The theme binding is module scope and outlives this file, so the
			// product default goes back before anything else renders.
			setThemeInstance(darkTheme);
			restoreDirOverrides(dirOverrides);
			if (tmpAgentDir) await removeWithRetries(tmpAgentDir);
		});

		it("resolves the ascii ramp on the Theme and draws the bar with it", async () => {
			tmpAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-bar-ramp-"));
			setAgentDir(tmpAgentDir);
			const dark = JSON.parse(await fs.readFile(DARK_THEME_PATH, "utf8")) as Record<string, unknown>;
			const base = (dark.symbols ?? {}) as Record<string, unknown>;
			const themesDir = getCustomThemesDir();
			await fs.mkdir(themesDir, { recursive: true });
			await fs.writeFile(
				path.join(themesDir, "ascii-bars.json"),
				JSON.stringify({ ...dark, name: "ascii-bars", symbols: { ...base, preset: "ascii" } }, null, 2),
			);

			const asciiTheme = await getThemeByName("ascii-bars");
			if (!asciiTheme) throw new Error("ascii theme unavailable");
			expect(asciiTheme.getSymbolPreset()).toBe("ascii");
			expect(asciiTheme.getBarRamp()).toEqual(BAR_RAMPS.ascii);

			// The seam: the renderer reads the ACTIVE theme's ramp, so publishing this
			// theme has to change what the bar is made of. ANSI is stripped because the
			// bar shimmers through the active theme and the escapes move with the clock.
			setThemeInstance(asciiTheme);
			expect(Bun.stripANSI(renderAsciiBar(0.375, 4, plainTheme))).toBe("[##--] 38%");
			expect(Bun.stripANSI(renderAsciiBar(0.06, 10, plainTheme))).toBe("[#---------] 6%");
			setThemeInstance(darkTheme);
			expect(Bun.stripANSI(renderAsciiBar(0.375, 4, plainTheme))).toBe("[█▌░░] 38%");
		});
	});
});
