/**
 * The framed tool block, at one width, in the two geometries.
 *
 * A tool block is the most repeated object in a session: every read, bash, grep and
 * diff result is one. The frame used to be drawn at the terminal width and every row
 * padded out to it, so a two-word result claimed the same rectangle as a hundred-line
 * diff and the right wall never moved. It is now drawn at the width of its own widest
 * row.
 *
 * Both arms render the SAME blocks through the SAME layout pass — the rows come from
 * `renderOutputBlock` either way — so the pair differs in the geometry and in nothing
 * else.
 *
 *     bun scripts/demos/render-tool-block.ts --width 100 [--wall] |
 *       bun scripts/demos/render-proof.ts --out /tmp/block --width 100
 *
 * `--wall` is the OFF arm: the frame each block had before, at the terminal width.
 * `--theme <name>` renders another theme; the default is titanium.
 */
import { padding, visibleWidth } from "@veyyon/tui";
import { theme } from "../../packages/coding-agent/src/modes/theme/theme";
import type { OutputBlockOptions } from "../../packages/coding-agent/src/tui/output-block";
import { renderOutputBlock } from "../../packages/coding-agent/src/tui/output-block";
import { flag, hasFlag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
await initRender(themeName, { settings: true });

const BLOCKS: Array<(w: number) => OutputBlockOptions> = [
	w => ({
		width: w,
		header: `${theme.styledSymbol("status.done", "success")} Read src/parser.ts`,
		state: "success",
		sections: [{ lines: ["export function parse(input: string): Ast {"] }],
	}),
	w => ({
		width: w,
		header: `${theme.styledSymbol("status.done", "success")} bash`,
		state: "success",
		sections: [{ lines: ["$ bun test test/parser.test.ts"] }, { label: "Output", lines: ["1 pass", "1 fail"] }],
	}),
	w => ({
		width: w,
		header: "✗ failed",
		state: "error",
		sections: [
			{ lines: ["$ npm run migrate:up"] },
			{ label: "Output", lines: ["exit 1: relation already exists", "⟦Exit: 1⟧"] },
		],
	}),
];

/**
 * The geometry every block had before: bars filled to the terminal width, content rows
 * padded out to it, and the right wall pinned to the last column whatever is inside.
 */
function widenToTerminal(lines: readonly string[], w: number): string[] {
	return lines.map(line => {
		const ink = visibleWidth(line);
		if (ink >= w) return line;
		// The frame's last cell is its right wall or corner: re-seat it at the terminal
		// edge and fill what the row gained, in that row's own last glyph.
		const last = [...line].pop() ?? "";
		const filler = last === theme.boxSharp.vertical ? padding(w - ink) : theme.boxSharp.horizontal.repeat(w - ink);
		return line.slice(0, line.length - last.length) + filler + last;
	});
}

const lines: string[] = [];
for (const build of BLOCKS) {
	const block = renderOutputBlock(build(width), theme);
	lines.push(...(hasFlag("wall") ? widenToTerminal(block, width) : block), "");
}

process.stdout.write(`${lines.join("\n")}\n`);
