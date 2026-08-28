import { padding, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { theme } from "../theme/theme";

export function fit(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w === width) return text;
	if (w < width) return text + padding(width - w);
	const cut = truncateToWidth(text, width);
	const cw = visibleWidth(cut);
	return cw < width ? cut + padding(width - cw) : cut;
}

function paint(s: string): string {
	return theme.fg("borderAccent", s);
}

export function topBorder(width: number, title: string): string {
	const box = theme.boxSharp;
	const inner = Math.max(0, width - 2);
	if (!title) return paint(box.topLeft + box.horizontal.repeat(inner) + box.topRight);
	const shown = truncateToWidth(` ${title} `, Math.max(0, inner - 2));
	const fillWidth = Math.max(0, inner - 1 - visibleWidth(shown));
	return (
		paint(box.topLeft + box.horizontal) +
		theme.bold(theme.fg("accent", shown)) +
		paint(box.horizontal.repeat(fillWidth) + box.topRight)
	);
}

export function divider(width: number): string {
	const box = theme.boxSharp;
	return paint(box.teeRight + box.horizontal.repeat(Math.max(0, width - 2)) + box.teeLeft);
}

export function bottomBorder(width: number): string {
	const box = theme.boxSharp;
	return paint(box.bottomLeft + box.horizontal.repeat(Math.max(0, width - 2)) + box.bottomRight);
}

export function row(content: string, width: number): string {
	const box = theme.boxSharp;
	return `${paint(box.vertical)} ${fit(content, Math.max(0, width - 4))} ${paint(box.vertical)}`;
}

function splitDividerCol(sidebarWidth: number): number {
	return sidebarWidth + 3;
}

export function splitBodyWidth(width: number, sidebarWidth: number): number {
	return Math.max(0, width - sidebarWidth - 7);
}

export function topBorderSplit(width: number, title: string, sidebarWidth: number): string {
	const box = theme.boxSharp;
	const dividerCol = splitDividerCol(sidebarWidth);
	const leftLen = Math.max(0, dividerCol - 1);
	const rightLen = Math.max(0, width - 2 - dividerCol);
	let left: string;
	if (!title) {
		left = paint(box.topLeft + box.horizontal.repeat(leftLen));
	} else {
		const shown = truncateToWidth(` ${title} `, Math.max(0, leftLen - 1));
		const fillWidth = Math.max(0, leftLen - 1 - visibleWidth(shown));
		left =
			paint(box.topLeft + box.horizontal) +
			theme.bold(theme.fg("accent", shown)) +
			paint(box.horizontal.repeat(fillWidth));
	}
	return left + paint(box.teeDown + box.horizontal.repeat(rightLen) + box.topRight);
}

export function dividerSplit(width: number, sidebarWidth: number): string {
	const box = theme.boxSharp;
	const dividerCol = splitDividerCol(sidebarWidth);
	const leftLen = Math.max(0, dividerCol - 1);
	const rightLen = Math.max(0, width - 2 - dividerCol);
	return paint(
		box.teeRight + box.horizontal.repeat(leftLen) + box.teeUp + box.horizontal.repeat(rightLen) + box.teeLeft,
	);
}

export function splitRow(sidebar: string, body: string, width: number, sidebarWidth: number): string {
	const box = theme.boxSharp;
	const bodyWidth = splitBodyWidth(width, sidebarWidth);
	const bar = paint(box.vertical);
	return `${bar} ${fit(sidebar, sidebarWidth)} ${bar} ${fit(body, bodyWidth)} ${bar}`;
}
