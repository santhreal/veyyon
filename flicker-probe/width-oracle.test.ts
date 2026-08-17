// SCRATCH PROBE: does any glyph the footer can contain make the TERMINAL count
// more screen cells than `visibleWidth` counts? `#prepareLine`
// (packages/tui/src/tui.ts:4245-4256) is the ONLY thing that keeps one composed
// row on one screen row: it truncates when `visibleWidth(line) > width`. Every
// emitter then counts one `\r\n` per LOGICAL row. A glyph the terminal measures
// wider than `visibleWidth` does soft-wraps, the paint lands one row lower than
// the cursor arithmetic assumes, and the previous frame's rows survive above it.

import { describe, it } from "bun:test";
import { visibleWidth } from "@veyyon/tui";
import { VirtualTerminal } from "../packages/tui/test/virtual-terminal";

const CANDIDATES: [string, string][] = [
	["braille spinner", "⠋"],
	["ascii", "abc"],
	["cjk", "界"],
	["emoji vs16", "❤️"],
	["emoji plain", "🙂"],
	["zwj family", "👨‍👩‍👧‍👦"],
	["flag", "🇯🇵"],
	["keycap", "1️⃣"],
	["skin tone", "👍🏽"],
	["nerd font pua", "\uf07b"],
	["powerline", "\ue0b0"],
	["box drawing", "─│╭╮"],
	["combining", "é"],
	["hangul jamo", "한"],
	["arrow", "→"],
	["ellipsis", "…"],
	["osc8 link", "\x1b]8;;https://a.test\x07link\x1b]8;;\x07"],
	["osc66 sized", "\x1b]66;s=2;BIG\x07"],
];

describe("width oracle", () => {
	it("reports every candidate where the terminal counts more cells than visibleWidth", async () => {
		for (const [name, sample] of CANDIDATES) {
			const term = new VirtualTerminal(40, 4, 100);
			term.write("\x1b[H");
			term.write(sample);
			await term.flush();
			const cursor = term.getCursor();
			const measured = visibleWidth(sample);
			const cells = cursor.row > 0 ? cursor.row * 40 + cursor.col : cursor.col;
			const verdict = cells === measured ? "agree" : cells > measured ? "TERMINAL WIDER" : "engine wider";
			console.log(
				`${name.padEnd(16)} visibleWidth=${String(measured).padStart(2)} terminalCells=${String(cells).padStart(2)}  ${verdict}`,
			);
		}
	});
});
