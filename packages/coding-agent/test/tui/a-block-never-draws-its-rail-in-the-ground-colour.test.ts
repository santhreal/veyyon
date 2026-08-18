/**
 * WHY THIS EXISTS.
 *
 * A tool block's only chrome is one glyph down its left edge. Twelve renderers
 * ask for that glyph in `borderMuted`, which on the default theme resolves to
 * `#202329` against the `#1e2127` a real terminal actually had — two levels apart
 * on the worst channel, measured off a recording, which is to say invisible. The
 * todo board, `write`, `ask`, `ast-edit` and the search results drew a rail that
 * was not there while the block above them kept its own.
 *
 * The class this closes is not "borderMuted is too dark on titanium". It is a
 * rail painted in ANY colour the reader cannot separate from the ground THAT IS
 * ON SCREEN: a theme that dims its borders, a state colour that lands on the
 * background, or a renderer asking for a colour nobody checked. The distinction
 * between the two grounds is the whole defect and the reason this file sweeps
 * both. Titanium declares black; `tui.paintGround: auto` refuses to paint black
 * onto a grey terminal, so the row sits on the operator's grey while the declared
 * ground says black. The first cut of the fix measured against the declared
 * ground, cleared `borderMuted` by 41 levels, and shipped the invisible rail — a
 * suite that only knew the declared ground was green for it.
 *
 * The themes come from the bundled registry at run time and the states from the
 * renderer's own option set, so adding either turns this red until someone
 * decides what its rail looks like.
 *
 * WHAT IT DOES NOT CATCH. Whether the rail is PLEASANT — it pins a channel
 * distance, not taste. It cannot see contrast the operator's terminal profile
 * destroys after the fact, it says nothing about a terminal that answers no OSC
 * 11 and is then repainted by something else, and a distance on the worst channel
 * is not a perceptual metric: two colours 12 levels apart on one channel and
 * equal on the others pass here and are still quiet.
 */

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { getBuiltinThemes } from "@veyyon/coding-agent/modes/theme/builtin-themes";
import { resetGroundTintsForTest, setDetectedTerminalGround } from "@veyyon/coding-agent/modes/theme/ground-tints";
import { createTheme, initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { renderOutputBlock } from "@veyyon/coding-agent/tui/output-block";
import { useFullColor } from "../helpers/theme-assertions";

/** Every block state a renderer may pass, plus the stateless block. */
const STATES = ["success", "pending", "running", "error", "warning", undefined] as const;

/** The rail colours renderers ask for by name rather than by state. */
const EXPLICIT_RAIL_COLORS = ["borderMuted", "border", "dim", "accent"] as const;

/**
 * The grounds a block is read on. `undefined` is the terminal that answered no
 * OSC 11, which is the only case where the theme's declared ground is the best
 * guess available; the two hexes are a real dark terminal and a real light one,
 * and every theme has to hold its rail on both because a theme does not get to
 * assume the terminal agreed with it.
 */
const GROUNDS = [undefined, "#1e2127", "#f7f7f5"] as const;

const MIN_DISTANCE = 12;

function channelDistance(a: string, b: string): number {
	let worst = 0;
	for (let i = 0; i < 3; i++) {
		const ca = Number.parseInt(a.slice(1 + i * 2, 3 + i * 2), 16);
		const cb = Number.parseInt(b.slice(1 + i * 2, 3 + i * 2), 16);
		worst = Math.max(worst, Math.abs(ca - cb));
	}
	return worst;
}

/** The `#rrggbb` of the first truecolor foreground in a rendered row. */
function firstFgHex(line: string): string | undefined {
	const match = /\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(line);
	if (!match) return undefined;
	const two = (c: string): string => Number(c).toString(16).padStart(2, "0");
	return `#${two(match[1]!)}${two(match[2]!)}${two(match[3]!)}`;
}

describe("the rail every tool block hangs its output on", () => {
	useFullColor();
	beforeAll(async () => {
		await initTheme();
	});
	afterEach(() => {
		resetGroundTintsForTest();
	});

	// Swept over the bundled registry rather than over the default theme: the
	// defect was one theme's border colour landing on the ground its blocks were
	// read on, and there is nothing special about the theme it happened on.
	for (const [name, json] of Object.entries(getBuiltinThemes())) {
		it(`is visible on every ground ${name} can be read on, in every state a block can be in`, () => {
			const theme = createTheme(json, { mode: "truecolor" });
			const rail = theme.symbol("block.rail");

			for (const reported of GROUNDS) {
				setDetectedTerminalGround(reported);
				const ground = theme.visibleGroundHex();
				expect(ground, `${name}: ground on screen`).toBe(reported ?? theme.getResolvedGroundHex());

				for (const state of STATES) {
					assertRailVisible(`state ${state ?? "none"} on ${ground}`, { state });
				}
				for (const borderColor of EXPLICIT_RAIL_COLORS) {
					assertRailVisible(`borderColor ${borderColor} on ${ground}`, { borderColor });
				}
			}

			function assertRailVisible(label: string, option: Partial<Parameters<typeof renderOutputBlock>[0]>): void {
				const lines = renderOutputBlock(
					{ header: "Bash", sections: [{ lines: ["running 6 tests"] }], width: 60, applyBg: false, ...option },
					theme,
				);
				const railed = lines.filter(line => stripVTControlCharacters(line).trimStart().startsWith(rail));
				expect(railed.length, `${name} / ${label} drew no rail at all`).toBeGreaterThan(0);
				for (const line of railed) {
					const hex = firstFgHex(line);
					expect(hex, `${name} / ${label} drew an uncoloured rail`).toBeDefined();
					expect(
						channelDistance(hex!, theme.visibleGroundHex()),
						`${name} / ${label}: rail ${hex} against ground ${theme.visibleGroundHex()}`,
					).toBeGreaterThanOrEqual(MIN_DISTANCE);
				}
			}
		});
	}
});
