import type { Component } from "@veyyon/tui";
import {
	ImageProtocol,
	padding,
	reopenBackgroundAfterResets,
	TERMINAL,
	visibleWidth,
	wrapTextWithAnsi,
} from "@veyyon/tui";
import { SGR_BG_RESET } from "@veyyon/tui/ansi";
import { clampLow } from "@veyyon/utils/math";
import type { Theme, ThemeColor } from "../modes/theme/theme";
import { getSixelLineMask } from "../utils/sixel";
import type { State } from "./types";
import { getStateBgColor, padToWidth } from "./utils";

export interface OutputBlockOptions {
	header?: string;
	headerMeta?: string;
	state?: State;
	sections?: Array<{ label?: string; lines: readonly string[]; separator?: boolean }>;
	width: number;
	applyBg?: boolean;
	contentPaddingLeft?: number;
	borderColor?: ThemeColor;
}

export const FRAMED_BLOCK_COMPONENT = Symbol("framedBlockComponent");

export type FramedBlockComponent = Component & { [FRAMED_BLOCK_COMPONENT]?: true };

export function markFramedBlockComponent<T extends Component>(component: T): T & FramedBlockComponent {
	(component as T & FramedBlockComponent)[FRAMED_BLOCK_COMPONENT] = true;
	return component as T & FramedBlockComponent;
}

export function isFramedBlockComponent(component: Component): boolean {
	return (component as FramedBlockComponent)[FRAMED_BLOCK_COMPONENT] === true;
}

export type BlockRow =
	| { kind: "header"; text: string }
	| { kind: "label"; text: string }
	| { kind: "rule" }
	| { kind: "content"; inner: string }
	| { kind: "sixel"; raw: string };

export const SEPARATOR_CELLS = 12;

export function normalizeContentPaddingLeft(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 1;
	return Math.max(0, Math.floor(value));
}

export function outputBlockContentWidth(width: number, contentPaddingLeft?: number): number {
	return Math.max(1, width - 2 - normalizeContentPaddingLeft(contentPaddingLeft));
}

function hexDigitAt(s: string, pos: number): number {
	const code = s.charCodeAt(pos);
	if (code >= 0x30 && code <= 0x39) return code - 0x30;
	if (code >= 0x61 && code <= 0x66) return code - 0x61 + 10;
	if (code >= 0x41 && code <= 0x46) return code - 0x41 + 10;
	return -1;
}

export function channelDistance(a: string, b: string): number {
	let worst = 0;
	for (let i = 0; i < 3; i++) {
		const base = 1 + i * 2;
		const ca = (hexDigitAt(a, base) << 4) | hexDigitAt(a, base + 1);
		const cb = (hexDigitAt(b, base) << 4) | hexDigitAt(b, base + 1);
		if (ca < 0 || cb < 0) return Number.POSITIVE_INFINITY;
		worst = Math.max(worst, Math.abs(ca - cb));
	}
	return worst;
}

export const RAIL_GROUND_MIN_DISTANCE = 12;

function visibleRailColor(requested: ThemeColor, theme: Theme): ThemeColor {
	const ground = theme.visibleGroundHex();
	const hex = theme.getColorHex(requested);
	if (channelDistance(hex, ground) >= RAIL_GROUND_MIN_DISTANCE) return requested;
	return channelDistance(theme.getColorHex("dim"), ground) >= RAIL_GROUND_MIN_DISTANCE ? "dim" : requested;
}

export function renderOutputBlock(options: OutputBlockOptions, theme: Theme): string[] {
	const { header, headerMeta, state, sections = [], width, applyBg = true } = options;
	const h = theme.boxSharp.horizontal;
	const rail = theme.symbol("block.rail");
	const lineWidth = Math.max(0, width);
	const requestedColor: ThemeColor =
		options.borderColor ??
		(state === "error"
			? "error"
			: state === "warning"
				? "warning"
				: state === "running" || state === "pending"
					? "accent"
					: "dim");
	const borderColor = visibleRailColor(requestedColor, theme);
	const border = (text: string) => theme.fg(borderColor, text);
	const bgFn = (() => {
		if (!state || !applyBg) return undefined;
		const bgAnsi = theme.getBgAnsi(getStateBgColor(state));
		return (text: string) => {
			return `${bgAnsi}${reopenBackgroundAfterResets(text, bgAnsi)}${SGR_BG_RESET}`;
		};
	})();

	const contentPaddingLeft = normalizeContentPaddingLeft(options.contentPaddingLeft);
	const chromeWidth = visibleWidth(rail) + 1 + contentPaddingLeft;
	const contentWidth = Math.max(0, lineWidth - chromeWidth);
	const contentLeftPadding = contentPaddingLeft > 0 ? padding(contentPaddingLeft) : "";

	const rows: BlockRow[] = [];
	const headerText = header && headerMeta ? `${header}${theme.sep.dot}${headerMeta}` : header || headerMeta || "";
	if (headerText) rows.push({ kind: "header", text: headerText });

	const normalizedSections = sections.length > 0 ? sections : [{ lines: [] as string[] }];
	for (let sectionIndex = 0; sectionIndex < normalizedSections.length; sectionIndex++) {
		const section = normalizedSections[sectionIndex]!;
		if (section.label) {
			rows.push({ kind: "label", text: section.label });
		} else if (section.separator && sectionIndex > 0) {
			rows.push({ kind: "rule" });
		}
		const allLines: string[] = [];
		for (let li = 0; li < section.lines.length; li++) {
			const src = section.lines[li]!;
			let start = 0;
			for (let si = 0; si <= src.length; si++) {
				if (si === src.length || src.charCodeAt(si) === 0x0a) {
					allLines.push(src.slice(start, si));
					start = si + 1;
				}
			}
		}
		const sixelLineMask = TERMINAL.imageProtocol === ImageProtocol.Sixel ? getSixelLineMask(allLines) : undefined;
		for (let lineIndex = 0; lineIndex < allLines.length; lineIndex++) {
			const line = allLines[lineIndex]!;
			if (sixelLineMask?.[lineIndex]) {
				rows.push({ kind: "sixel", raw: line });
				continue;
			}
			const wrappedLines = wrapTextWithAnsi(line.trimEnd(), contentWidth);
			for (const wrappedLine of wrappedLines) {
				rows.push({ kind: "content", inner: wrappedLine });
			}
		}
	}

	let blockWidth = 0;
	for (const row of rows) {
		if (row.kind === "sixel") continue;
		const ink =
			row.kind === "header"
				? visibleWidth(row.text) + chromeWidth
				: row.kind === "content"
					? visibleWidth(row.inner) + chromeWidth
					: row.kind === "label"
						? visibleWidth(row.text) + chromeWidth
						: SEPARATOR_CELLS + chromeWidth;
		blockWidth = Math.max(blockWidth, ink + 1);
	}
	blockWidth = Math.min(lineWidth, blockWidth);
	const innerWidth = Math.max(0, blockWidth - chromeWidth);

	const onRail = (body: string): string => `${border(rail)} ${body}`;

	const lines: string[] = [];
	for (const row of rows) {
		if (row.kind === "sixel") {
			lines.push(row.raw);
			continue;
		}
		const line =
			row.kind === "header"
				? // The header sits ON the rail like every other row. It used to start at
					onRail(row.text)
				: row.kind === "content"
					? onRail(`${contentLeftPadding}${row.inner}`)
					: row.kind === "label"
						? // A label names the rows under it, so it sits at their indent rather than one
							onRail(`${contentLeftPadding}${row.text}`)
						: onRail(border(h.repeat(clampLow(innerWidth, 0, SEPARATOR_CELLS))));
		lines.push(bgFn ? padToWidth(line, blockWidth, bgFn) : line);
	}

	return lines;
}
