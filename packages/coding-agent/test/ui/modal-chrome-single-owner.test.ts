/**
 * Every overlay asks the shell how many rows its chrome costs. Nobody restates it.
 *
 * `ModalShell` reserves a fixed number of rows outside the body budget — top bar,
 * vertical padding, footer divider, footer band, bottom border — and an overlay
 * that lays out its own content has to subtract them before deciding what fits.
 * `minModalChromeRows(sizing)` is that number's one owner.
 *
 * Both overlays that need it once computed it by hand as `3 + footerLines + vPad`.
 * `ask-dialog` was moved onto the shell's own function; `plan-review-overlay` was
 * not, and its comment claimed the two were "identically-derived". Then the shell
 * changed: vertical padding is charged on BOTH sides of the body, so the real cost
 * grew by one `vPad`. The copy could not know, so the overlay sized its body a
 * `vPad` too tall and no test failed — the arithmetic was still self-consistent,
 * just no longer the shell's.
 *
 * That is the whole failure mode of a restated constant, and it is why these
 * tests assert on the SOURCE rather than on a rendered frame: a frame-level
 * assertion would only catch it at the terminal heights where the extra row
 * happens to change what fits, which is exactly the intermittency that let it
 * survive.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODAL_SIZING_LARGE, minModalChromeRows } from "@veyyon/coding-agent/modes/components/modal-shell";

const COMPONENTS = fileURLToPath(new URL("../../src/modes/components/", import.meta.url));

/** The overlays that subtract modal chrome before laying out their own content. */
const OVERLAYS = ["plan-review-overlay.ts", "ask-dialog.ts"] as const;

const sourceOf = (file: string) => readFileSync(join(COMPONENTS, file), "utf8");

describe("modal chrome has one owner", () => {
	it("is a real number, so the assertions below are not vacuous", () => {
		expect(minModalChromeRows(MODAL_SIZING_LARGE)).toBeGreaterThan(0);
	});

	it("charges vertical padding on both sides of the body", () => {
		// The change that broke the copy, pinned here so its cost is explicit: the
		// chrome is one `vPad` taller than the old hand-rolled formula produced.
		const sizing = MODAL_SIZING_LARGE;

		expect(minModalChromeRows(sizing)).toBe(3 + 2 * sizing.vPad + sizing.footerLines);
		expect(minModalChromeRows(sizing)).toBe(3 + sizing.footerLines + sizing.vPad + sizing.vPad);
	});

	for (const overlay of OVERLAYS) {
		it(`${overlay} derives its chrome rows from the shell`, () => {
			expect(sourceOf(overlay)).toContain("minModalChromeRows(MODAL_SIZING_LARGE)");
		});

		it(`${overlay} does not restate the chrome arithmetic`, () => {
			// The exact shape that drifted. Spelled out rather than approximated,
			// because a near-miss regex would either miss a variant or fail on prose
			// describing the old formula (both files' comments still name it).
			const code = sourceOf(overlay)
				.split("\n")
				.filter(line => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
				.join("\n");

			expect(code).not.toContain("3 + MODAL_SIZING_LARGE.footerLines + MODAL_SIZING_LARGE.vPad");
			expect(code).not.toMatch(/const CHROME_ROWS = \d/);
		});
	}

	it("scales with the sizing it is given", () => {
		// A caller passing a different sizing must get that sizing's answer; a
		// constant that ignored its argument would satisfy every test above.
		const taller = { ...MODAL_SIZING_LARGE, footerLines: MODAL_SIZING_LARGE.footerLines + 2 };

		expect(minModalChromeRows(taller)).toBe(minModalChromeRows(MODAL_SIZING_LARGE) + 2);
	});
});
