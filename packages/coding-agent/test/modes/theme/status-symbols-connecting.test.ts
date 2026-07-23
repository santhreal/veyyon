/**
 * TOUCH-2: `status.connecting` (◌) and `status.active` (●) exist as theme
 * symbols so connect-state dots degrade under the symbol presets. The defect
 * this locks out: mcp/command/advisor surfaces hardcoded `◌`/`●` literals at
 * render sites, so an ascii terminal received glyphs it cannot render and a
 * nerd-font user never got the nerd variants.
 *
 * Locks:
 *  1. All three presets define both keys.
 *  2. The ascii preset's values are pure printable ascii.
 *  3. The Theme.status getter exposes them (the routing surface callsites use).
 *  4. The routed callsites no longer contain the raw literals.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ThemeJson } from "@veyyon/coding-agent/modes/theme/color";
import { defaultThemes } from "@veyyon/coding-agent/modes/theme/defaults";
import { SYMBOL_PRESETS } from "@veyyon/coding-agent/modes/theme/symbols";
import { createTheme } from "@veyyon/coding-agent/modes/theme/theme";

const SRC = path.resolve(import.meta.dir, "../../../src");

describe("status.connecting / status.active symbols", () => {
	it("exist in every preset", () => {
		for (const [name, preset] of Object.entries(SYMBOL_PRESETS)) {
			expect(preset["status.connecting"], `${name}.status.connecting`).toBeTruthy();
			expect(preset["status.active"], `${name}.status.active`).toBeTruthy();
		}
	});

	it("degrade to pure printable ascii under the ascii preset", () => {
		const ascii = SYMBOL_PRESETS.ascii;
		for (const key of ["status.connecting", "status.active"] as const) {
			expect(ascii[key]).toMatch(/^[\x20-\x7e]+$/);
		}
	});

	it("surface through the Theme.status getter with preset values", () => {
		const unicode = createTheme(defaultThemes.titanium as ThemeJson, {
			mode: "truecolor",
			symbolPresetOverride: "unicode",
		});
		// ◦ pairs with ● as its unfilled state; the former ◌ (U+25CC) is the
		// combining-mark placeholder glyph and read as a rendering artifact.
		expect(unicode.status.connecting).toBe("◦");
		expect(unicode.status.active).toBe("●");
		const ascii = createTheme(defaultThemes.titanium as ThemeJson, {
			mode: "truecolor",
			symbolPresetOverride: "ascii",
		});
		expect(ascii.status.connecting).toBe("o");
		expect(ascii.status.active).toBe("*");
	});

	/** Source-level lock: the routed callsites must not regress to literals.
	 * (A render-site literal bypasses every preset — the exact TOUCH-2 bug.) */
	it("keeps the routed callsites literal-free", () => {
		for (const rel of [
			"modes/controllers/mcp-command-controller.ts",
			"modes/controllers/command-controller.ts",
			"modes/components/advisor-config.ts",
		]) {
			const src = fs.readFileSync(path.join(SRC, rel), "utf8");
			// Comments may mention the glyphs; code strings must not.
			const codeLines = src.split("\n").filter(l => !l.trim().startsWith("*") && !l.trim().startsWith("//"));
			for (const line of codeLines) {
				expect(line, `${rel}: ${line.trim()}`).not.toMatch(/["`][^"`]*[◌◦●][^"`]*["`]/);
			}
		}
	});
});
