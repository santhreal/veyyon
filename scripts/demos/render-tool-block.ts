/**
 * Render tool execution output blocks across status states and borders.
 *
 * Constructs output block options for read operations, multi-section command executions,
 * and command failure messages. Renders each block using standard transcript block styling
 * or enclosed box border styling, printing the resulting lines as ANSI text.
 *
 * Usage:
 *   bun scripts/demos/render-tool-block.ts [--box] [--width 100] [--theme titanium]
 */

import { padding } from "@veyyon/utils/padding";
import { visibleWidth } from "@veyyon/utils/width";
import { wrapTextWithAnsi } from "@veyyon/utils/wrap";
import type { OutputBlockOptions } from "../../packages/coding-agent/src/modes/terminal/draw/output-block";
import { renderOutputBlock } from "../../packages/coding-agent/src/modes/terminal/draw/output-block";
import { theme } from "../../packages/coding-agent/src/theme/theme";
import { renderDemo } from "./render-args";

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

await renderDemo(
	({ width, hasFlag }) => {
		const lines: string[] = [];
		for (const build of BLOCKS) {
			const options = build(width);
			lines.push(...(hasFlag("box") ? renderAsBox(options, width) : renderOutputBlock(options, theme)), "");
		}
		return lines;
	},
	{ settings: true },
);
