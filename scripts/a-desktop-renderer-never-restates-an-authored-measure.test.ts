/**
 * A desktop renderer never writes an authored measure back into its source.
 *
 * The desktop's geometry is authored in `crates/veyyon-desktop-tokens/tokens`
 * and read through a token struct. A renderer that also states the number is a
 * second authority for one measure: edit the file and the drawing does not
 * move, because the source still holds the old value somewhere in an offset.
 *
 * THE DEFECT CLASS. The shape that motivated this gate is narrower and worse
 * than a stray magic number. A sweep asserts that every authored measure moves
 * a pixel, and the cheapest way to pass it without reading the measure is an
 * offset against the authored value:
 *
 *     let offset = px((geometry.right_panel_default_width_px - 540.0) * 0.1);
 *     if geometry.run_bar_max_controls > 4 { … }
 *     let h = px((geometry.results_key_hint_size.line_height - 16.0).max(0.0));
 *
 * 540, 4 and 16 are what those three tokens are authored as, so every one of
 * these terms is exactly zero in the shipped build and non-zero only while a
 * test doubles the number. No operator ever sees the pixel it claims to move,
 * the authored value is duplicated into the source as a literal, and the suite
 * that exists to find dead measures reports the measure as live. Six of these
 * landed in one round across five files, which is why the rule is mechanical
 * now rather than a thing review is asked to remember.
 *
 * WHAT IT CATCHES. A numeric literal other than 0 or 1 added to, subtracted
 * from, or compared against a value read out of a token struct, anywhere in the
 * two crates that draw: `veyyon-desktop-surface` and `veyyon-desktop-kit`.
 * Those two operations are what an authored-value offset is made of. A literal
 * MULTIPLIER is not flagged: `ratio * viewport` and `inset * 2.0` are how a
 * measure is legitimately applied, and `mul_add` is the same operation spelled
 * for one rounding.
 *
 * WHAT IT DOES NOT CATCH, and a reader should not assume otherwise:
 *   - A token laundered through a local first. `let w = geometry.width_px;`
 *     then `if (w - 256.0).abs() < 1.0` reads as arithmetic on a local here.
 *     Closing that needs dataflow, and the gate would then need to know which
 *     locals are token-derived.
 *   - A literal that duplicates an authored value without arithmetic, such as
 *     `const CARD_WIDTH_PX: f32 = 420.0;` beside an authored 420. That is the
 *     ordinary magic-number problem, it has false positives in byte limits and
 *     bit shifts, and it belongs to a different rule.
 *   - Anything outside the two drawing crates. `veyyon-desktop` holds scene
 *     fixtures and protocol constants whose numbers are data, not geometry.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** The crates whose job is to draw, and so to read measures rather than state them. */
const DRAWING_CRATES = ["crates/veyyon-desktop-surface/src", "crates/veyyon-desktop-kit/src"];

/**
 * The receivers a measure is read from.
 *
 * Every one is a token struct or a field holding one, named the same way at
 * every call site in these crates. A receiver that is not here reads as an
 * ordinary local, which is the documented blind spot above.
 */
const TOKEN_RECEIVER =
	/\b(geometry|panels|shell|composer|surface|queue|palette|settings|transcript|metrics|elevation|scale|motion|breakpoints)\.[a-z_][a-z0-9_]*/;

/**
 * A literal offset or comparison: `- 540.0`, `+ 0.025`, `> 4`, `<= 18.0`.
 *
 * `0` and `1` are excluded because they are identities and clamps
 * (`.max(0.0)`, `.min(1.0)`, `- 1` for a zero-based index), never an authored
 * measure written back.
 */
const LITERAL_OFFSET = /(?:[-+]|[<>]=?|==|!=)\s*(\d+(?:\.\d+)?)/g;

/** Source lines, with comment tails and inline test modules dropped. */
function drawingLines(): { file: string; line: number; text: string }[] {
	const out: { file: string; line: number; text: string }[] = [];
	for (const crate of DRAWING_CRATES) {
		for (const file of rustFiles(path.join(REPO_ROOT, crate))) {
			const text = fs.readFileSync(file, "utf8");
			const relative = path.relative(REPO_ROOT, file);
			const lines = text.split("\n");
			for (const [index, raw] of lines.entries()) {
				// An inline `mod tests` states values on purpose: it is the
				// place a fixture may hold the number it is asserting.
				if (/^\s*#\[cfg\(test\)\]/.test(raw)) break;
				out.push({ file: relative, line: index + 1, text: raw });
			}
		}
	}
	return out;
}

function rustFiles(dir: string, out: string[] = []): string[] {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			rustFiles(full, out);
		} else if (entry.name.endsWith(".rs")) {
			out.push(full);
		}
	}
	return out;
}

/** The offending literal on one line, if the line offsets a measure by one. */
export function restatedMeasure(source: string): string | undefined {
	const code = source.split("//")[0] ?? "";
	if (!TOKEN_RECEIVER.test(code)) {
		return undefined;
	}
	// `mul_add(-2.0, x)` is a multiply, spelled for one rounding step.
	const scanned = code.replaceAll(/mul_add\([^)]*\)/g, "");
	for (const match of scanned.matchAll(LITERAL_OFFSET)) {
		const value = Number(match[1]);
		if (value !== 0 && value !== 1) {
			return match[0].trim();
		}
	}
	return undefined;
}

describe("a desktop renderer never restates an authored measure", () => {
	it("flags no literal offset against a token read", () => {
		const offenders = drawingLines()
			.map(entry => ({ ...entry, literal: restatedMeasure(entry.text) }))
			.filter(entry => entry.literal !== undefined)
			.map(entry => `${entry.file}:${entry.line} offsets a measure by ${entry.literal}: ${entry.text.trim()}`);
		expect(offenders).toEqual([]);
	});

	it("reads the two shapes the defect takes", () => {
		expect(restatedMeasure("let o = px((geometry.right_panel_default_width_px - 540.0) * 0.1);")).toBe("- 540.0");
		expect(restatedMeasure("if geometry.run_bar_max_controls > 4 {")).toBe("> 4");
	});

	it("leaves a measure applied without a literal offset alone", () => {
		expect(restatedMeasure("let w = px(geometry.width_px);")).toBeUndefined();
		expect(restatedMeasure("let h = px(geometry.card_px * 0.5);")).toBeUndefined();
		expect(restatedMeasure("let b = geometry.content_inset.mul_add(-2.0, height_px);")).toBeUndefined();
		expect(restatedMeasure("let c = px(geometry.row_height_px).max(px(0.0));")).toBeUndefined();
		expect(restatedMeasure("let n = geometry.rows - 1;")).toBeUndefined();
	});

	it("ignores a number in a comment and a line with no measure in it", () => {
		expect(restatedMeasure("// geometry.width_px - 540.0 is the old shape")).toBeUndefined();
		expect(restatedMeasure("let x = width - 540.0;")).toBeUndefined();
	});
});
