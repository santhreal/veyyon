/**
 * WHY THIS EXISTS.
 *
 * A framed block wraps its content rows at the width left after the rail, and draws its header and
 * its section labels as one row each. Those two are never wrapped, so an unbroken run in them — a host
 * name an `ssh` card states, a path a `write` card names — was drawn past the block's edge and the
 * terminal folded it onto the next line under the rail. The content rows had a width; the header and
 * the labels had none.
 *
 * THE CLASS THIS CLOSES. Any row `renderOutputBlock` emits that is wider than the width it was asked
 * to draw at, whatever kind of row it is and whatever the row holds: an unbroken run, a tab, a wide
 * glyph, styling. The sweep crosses every block state, both backgrounds, every content indent a
 * renderer passes and every width down to one column. It also pins that the clip adds nothing: a
 * header the card did not ask to fit keeps a prefix of itself, and the ellipsis is the card's to ask
 * for through `descriptionFits`.
 *
 * WHAT IT DOES NOT CATCH. A sixel row, which is image data the terminal places rather than text it
 * lays out, and which is emitted as the renderer gave it. Whether a clipped header still says what the
 * card needed it to say, which the per-tool differential suites own against the renderer main drew.
 */

import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderOutputBlock } from "@veyyon/coding-agent/modes/terminal/draw/output-block";
import { theme } from "@veyyon/coding-agent/theme/theme";
import { visibleWidth } from "@veyyon/utils/width";
import { useDifferentialTheme } from "../../../differential/harness";

useDifferentialTheme();

/** Every block state a renderer may pass, plus the stateless block. */
const STATES = ["success", "pending", "running", "error", "warning", undefined] as const;

/** Every width from wider than any row here down to one column. */
const WIDTHS = [240, 160, 100, 80, 60, 40, 24, 12, 6, 3, 2, 1] as const;

/** The content indents renderers pass, including the default and none. */
const PADDINGS = [undefined, 0, 1, 3] as const;

const RUN = "x".repeat(300);

/** What a header or a label can hold that cannot be wrapped away, built once the theme is loaded. */
const TEXTS: Record<string, () => string> = {
	"an unbroken run": () => `ssh deploy@${RUN}.example.internal`,
	"a tab before a run": () => `write\t/repo/${RUN}.ts`,
	"wide glyphs": () => "漢字".repeat(120),
	"a styled run": () => theme.fg("accent", `/repo/${RUN}`),
};

describe("a framed block row", () => {
	for (const [name, build] of Object.entries(TEXTS)) {
		it(`never runs past the width it is drawn at when its header, meta and labels hold ${name}`, () => {
			const text = build();
			for (const state of STATES) {
				for (const applyBg of [true, false]) {
					for (const contentPaddingLeft of PADDINGS) {
						for (const width of WIDTHS) {
							const lines = renderOutputBlock(
								{
									header: text,
									headerMeta: text,
									state,
									applyBg,
									contentPaddingLeft,
									width,
									sections: [
										{ label: text, lines: [text] },
										{ label: text, lines: [], separator: true },
										{ lines: ["tail"], separator: true },
									],
								},
								theme,
							);
							// Header, two labels, the wrapped content, the rule and the tail: every kind a
							// block draws, so a kind that stops being clipped cannot hide behind another.
							expect(lines.length).toBeGreaterThanOrEqual(5);
							for (const line of lines) {
								expect(visibleWidth(line)).toBeLessThanOrEqual(width);
							}
						}
					}
				}
			}
		});
	}

	it("keeps a prefix of a header and a label it clips, with no ellipsis added", () => {
		const header = `ssh deploy@${RUN}`;
		const label = `/repo/${RUN}`;
		const wide = renderOutputBlock(
			{ header, width: 1000, contentPaddingLeft: 0, sections: [{ label, lines: [] }] },
			theme,
		).map(line => stripVTControlCharacters(line));
		for (const width of [80, 40, 12]) {
			const narrow = renderOutputBlock(
				{ header, width, contentPaddingLeft: 0, sections: [{ label, lines: [] }] },
				theme,
			).map(line => stripVTControlCharacters(line));
			for (const [index, row] of narrow.entries()) {
				expect(visibleWidth(row)).toBe(width);
				expect(row).not.toContain("…");
				expect(wide[index]?.startsWith(row)).toBe(true);
			}
		}
	});
});
