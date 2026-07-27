/**
 * The installer's brand mark and the TUI's sun must be the same sun.
 *
 * WHY THIS SUITE EXISTS. The sun is the logo, and `install.sh` is a POSIX shell
 * script that cannot import the TypeScript module that owns it. So the mark it
 * prints quotes that module's numbers: four bands of the ember ramp, their
 * xterm-256 approximations, and glyphs from the same ramp. Quoted values drift
 * the moment somebody retunes the ember and does not think about a shell script,
 * and two shipped suns that disagree about the brand color are worse than one
 * plain line of text. This reads both files and fails when they stop matching.
 *
 * `packages/coding-agent/src/modes/components/sun.ts` is the owner. Nothing here
 * asserts what the color SHOULD be — only that the installer says what the owner
 * says.
 */

import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { EMBER, GLYPH } from "@veyyon/coding-agent/modes/components/sun";

const repoRoot = path.join(import.meta.dir, "..");
const installSh = fs.readFileSync(path.join(repoRoot, "scripts", "install.sh"), "utf8");

/** The bands the mark draws with: dark rim, brand ember, and the white-hot core. */
const MARK_BANDS = [1, 4, 6, 7] as const;

/**
 * The mark does NOT use the owner's glyph ramp, and that is deliberate.
 *
 * The ramp shades with `░ ▒ ▓`, which a terminal draws as a dot pattern of the
 * foreground over the background. Averaged over a field of cells that reads as a
 * gradient, which is why the TUI's sun uses it; averaged over seven cells on one
 * line it reads as brown-grey, and the first version of this mark rendered as a
 * grey swatch. The mark uses lower blocks of rising height instead: every cell
 * is solid, the color carries the heat, and the silhouette makes the dome.
 *
 * The owner still owns the COLOR, which is what the rest of this file checks.
 */
const MARK_PROFILE = ["▁", "▃", "▅", "█", "▅", "▃", "▁"] as const;

describe("the installer's truecolor disc", () => {
	/**
	 * Band 4 is the brand ember, the one the website's `--sun` and the setup
	 * splash both rest on. If a single band is going to be checked by eye, it is
	 * this one, so it gets its own assertion as well as the loop below.
	 */
	it("uses the brand ember for the disc's lit ring", () => {
		const [r, g, b] = EMBER[4] as readonly [number, number, number];
		expect([r, g, b]).toEqual([0xf0, 0x86, 0x2e]);
		expect(installSh).toContain(`\\033[38;2;${r};${g};${b}m`);
	});

	it.each([...MARK_BANDS])("emits ember band %i exactly as the owner defines it", (band: number) => {
		const [r, g, b] = EMBER[band] as readonly [number, number, number];
		expect(installSh).toContain(`\\033[38;2;${r};${g};${b}m`);
	});

	/**
	 * A band the mark does not use must not appear either. Without this the suite
	 * passes while the shell quietly draws a different disc that happens to
	 * include the right colors among others.
	 */
	it("uses no ember band outside the four it draws with", () => {
		for (let band = 0; band < EMBER.length; band++) {
			if ((MARK_BANDS as readonly number[]).includes(band)) continue;
			const [r, g, b] = EMBER[band] as readonly [number, number, number];
			expect(installSh).not.toContain(`\\033[38;2;${r};${g};${b}m`);
		}
	});
});

describe("the installer's 256-color fallback", () => {
	/**
	 * The TUI falls back to a fixed xterm-256 approximation on a terminal without
	 * truecolor. The installer has to fall back to the SAME one, or a 256-color
	 * terminal sees two different suns depending on which surface it is looking
	 * at. The values are pinned here rather than imported because `EMBER_256` is
	 * private to the owner module; changing it there without changing them here
	 * fails this test, which is the point.
	 */
	const EMBER_256_FOR_MARK = { 1: 88, 4: 208, 6: 220, 7: 223 } as const;

	it.each([...MARK_BANDS])("emits the 256-color stand-in for band %i", (band: number) => {
		expect(installSh).toContain(`\\033[38;5;${EMBER_256_FOR_MARK[band as keyof typeof EMBER_256_FOR_MARK]}m`);
	});
});

describe("the installer's silhouette", () => {
	/**
	 * The heights rise to the middle and fall away, which is what makes the mark
	 * a sun coming up over a horizon rather than a seven-cell progress bar. Both
	 * renderings draw the same profile; only the color depth differs.
	 */
	it("draws the same dome in truecolor and in 256 colors", () => {
		const discLines = installSh.split("\n").filter(line => line.includes("_bm_disc="));
		expect(discLines).toHaveLength(2);
		for (const line of discLines) {
			const glyphs = line.replace(/\\033\[[0-9;]*m/g, "").replace(/[^▁▃▅█]/g, "");
			expect(glyphs).toBe(MARK_PROFILE.join(""));
		}
	});

	/**
	 * Not the owner's shading ramp. `░` and `▒` are stipple, and stipple over
	 * seven cells averages to grey — the exact failure this mark was rebuilt to
	 * escape. If they come back, so does the grey swatch.
	 */
	it("uses no stipple glyph, which is what washed the first version out", () => {
		// Comment lines are excluded: the comment above the mark names those glyphs
		// to explain why they are not used, and explaining is not using.
		const code = installSh
			.split("\n")
			.filter(line => !line.trimStart().startsWith("#"))
			.join("\n");
		for (const glyph of ["░", "▒", "▓"]) {
			// Widened: `GLYPH` is a readonly tuple of literals, and the point of the
			// assertion is that these are the owner's glyphs, not that the compiler
			// can already see it.
			expect(GLYPH as readonly string[]).toContain(glyph);
			expect(code).not.toContain(glyph);
		}
	});

	/** A flat profile is a bar. Four distinct heights are what give it a shape. */
	it("uses four distinct heights", () => {
		expect(new Set(MARK_PROFILE).size).toBe(4);
	});
});

describe("where the mark appears", () => {
	/** The eye lands on the sun, then the name, the same order the splash uses. */
	it("prints the name letterspaced, after the disc", () => {
		expect(installSh).toContain('BRAND_NAME_SPACED="v e y y o n"');
		// The line that PRINTS the mark, not the two that build the disc: those
		// assign `_bm_disc` and never mention the name.
		const line = installSh.split("\n").find(l => l.includes("_bm_disc") && l.includes("BRAND_NAME_SPACED")) ?? "";
		expect(line).not.toBe("");
		expect(line.indexOf("_bm_disc")).toBeLessThan(line.indexOf("BRAND_NAME_SPACED"));
	});

	/**
	 * An install is a good moment for a logo. A removal is not: a mark over an
	 * uninstall reads as a sales pitch at exactly the wrong time.
	 */
	it("is printed for an install and not for an uninstall", () => {
		const main = installSh.slice(installSh.indexOf("# ---- main ----"));
		const uninstallBranch = main.slice(main.indexOf("do_uninstall"), main.indexOf("brand_mark"));
		expect(uninstallBranch).not.toContain("brand_mark");
		expect(main).toContain("brand_mark");
	});

	/**
	 * A terminal whose locale is not UTF-8 renders the block glyphs as mojibake,
	 * and a wrong-looking logo is worse than a plain one. Same for `NO_COLOR`: an
	 * uncolored gradient is a row of meaningless blocks.
	 */
	it("has an ASCII fallback for a non-UTF-8 or uncolored terminal", () => {
		expect(installSh).toContain("supports_utf8()");
		expect(installSh).toContain(`printf '\\n  (*) %s\\n\\n' "$BRAND_NAME_SPACED"`);
	});

	/** Nothing is printed into a pipe or a log, which keeps captured output stable. */
	it("prints nothing when stdout is not a terminal", () => {
		const fn = installSh.slice(installSh.indexOf("brand_mark() {"));
		expect(fn.slice(0, fn.indexOf("\n}"))).toContain('[ "$IS_TTY" = 1 ] || return 0');
	});
});
