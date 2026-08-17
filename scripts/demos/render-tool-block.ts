/**
 * The tool block, at one width, in the two chromes.
 *
 * A tool block is the most repeated object in a session: every read, bash, grep and
 * diff result is one. It used to be a box — a rule with the title cut into it, a wall
 * down each side, a rule under the last line — drawn at the terminal width with every
 * row padded out to reach it. It is now a title line and a rail: one thin glyph down
 * the left of the output, nothing above it, nothing below it, nothing to the right.
 *
 * Both arms render the SAME blocks from the SAME options, so the pair differs in the
 * chrome and in nothing else. `--box` is the OFF arm and rebuilds the old geometry
 * here rather than in the product, which is the only way to put the two side by side
 * once the product has stopped drawing one of them.
 *
 *     bun scripts/demos/render-tool-block.ts --width 100 [--box] |
 *       bun scripts/demos/render-proof.ts --out /tmp/block --width 100
 *
 * `--theme <name>` renders another theme; the default is titanium.
 */
import { padding, visibleWidth, wrapTextWithAnsi } from "@veyyon/tui";
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
 * The chrome every block had before: a bar with the title cut into it, a wall down
 * each side, a bar under the last row, all drawn to the terminal width.
 */
function renderAsBox(options: OutputBlockOptions, w: number): string[] {
	const box = theme.boxSharp;
	const h = box.horizontal;
	const cap = h.repeat(3);
	const state = options.state;
	const color = state === "error" ? "error" : state === "warning" ? "warning" : "dim";
	const border = (text: string) => theme.fg(color, text);
	const inner = Math.max(1, w - 3);

	const bar = (left: string, right: string, label?: string): string => {
		const leftGlyphs = `${left}${cap}`;
		if (!label) return border(leftGlyphs + h.repeat(Math.max(0, w - visibleWidth(leftGlyphs) - 1)) + right);
		const text = ` ${label} `;
		const fill = Math.max(0, w - visibleWidth(leftGlyphs) - visibleWidth(text) - 1);
		return `${border(leftGlyphs)}${text}${border(h.repeat(fill))}${border(right)}`;
	};

	const title = [options.header, options.headerMeta].filter(Boolean).join(theme.sep.dot);
	const lines = [bar(box.topLeft, box.topRight, title || undefined)];
	const sections = options.sections ?? [];
	for (let i = 0; i < sections.length; i++) {
		const section = sections[i]!;
		if (section.label) lines.push(bar(box.teeRight, box.teeLeft, section.label));
		else if (section.separator && i > 0) lines.push(bar(box.teeRight, box.teeLeft));
		for (const raw of section.lines.flatMap(line => line.split("\n"))) {
			for (const line of wrapTextWithAnsi(raw.trimEnd(), inner)) {
				lines.push(
					`${border(box.vertical)} ${line}${padding(Math.max(0, inner - visibleWidth(line)))}${border(box.vertical)}`,
				);
			}
		}
	}
	lines.push(bar(box.bottomLeft, box.bottomRight));
	return lines;
}

const lines: string[] = [];
for (const build of BLOCKS) {
	const options = build(width);
	lines.push(...(hasFlag("box") ? renderAsBox(options, width) : renderOutputBlock(options, theme)), "");
}

process.stdout.write(`${lines.join("\n")}\n`);
